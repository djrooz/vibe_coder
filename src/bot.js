import { q } from './db.js';
import { tg, send, escapeHtml } from './tg.js';
import { createLead, findOpenLeadByTgUser, appendMessage } from './leads.js';

const CATEGORIES = [
  ['site', 'Сайт'],
  ['ads', 'Реклама'],
  ['smm', 'SMM'],
  ['other', 'Другое'],
];

const BOT_TAG = 'telegram-бот';
const PERSONAL_TAG = 'telegram-личный';

export async function handleUpdate(u) {
  if (u.message) return onMessage(u.message);
  if (u.callback_query) return onCallback(u.callback_query);
  if (u.business_connection) return onBusinessConnection(u.business_connection);
  if (u.business_message) return onBusinessMessage(u.business_message);
}

// ---------- Сессии диалога ----------

async function getSession(chatId) {
  const [s] = await q('SELECT step, data FROM bot_sessions WHERE chat_id = $1', [chatId]);
  return s ?? null;
}

async function setSession(chatId, step, data) {
  await q(
    `INSERT INTO bot_sessions (chat_id, step, data, updated_at) VALUES ($1, $2, $3, now())
     ON CONFLICT (chat_id) DO UPDATE SET step = EXCLUDED.step, data = EXCLUDED.data, updated_at = now()`,
    [chatId, step, JSON.stringify(data)],
  );
}

async function clearSession(chatId) {
  await q('DELETE FROM bot_sessions WHERE chat_id = $1', [chatId]);
}

// ---------- Пункт 1: заявка через бота ----------

function describe(m) {
  if (m.text) return m.text;
  if (m.caption) return m.caption;
  if (m.contact) return `Контакт: +${m.contact.phone_number.replace(/^\+/, '')}`;
  if (m.photo) return '[фото]';
  if (m.voice) return '[голосовое сообщение]';
  if (m.document) return `[файл ${m.document.file_name ?? ''}]`;
  return '[вложение]';
}

async function startDialog(chatId, from) {
  await setSession(chatId, 'name', { username: from.username ?? null });
  const keyboard = from.first_name
    ? { reply_markup: { keyboard: [[{ text: from.first_name }]], resize_keyboard: true, one_time_keyboard: true } }
    : {};
  await send(
    chatId,
    'Здравствуйте! Я помогу оставить заявку в агентство — это займёт минуту.\n\n<b>Как вас зовут?</b>',
    keyboard,
  );
}

async function askContact(chatId, data) {
  const rows = [[{ text: '📱 Поделиться номером', request_contact: true }]];
  if (data.username) rows.push([{ text: `@${data.username}` }]);
  await send(chatId, '<b>Как с вами связаться?</b>\nНажмите кнопку или напишите телефон / e-mail / ник.', {
    reply_markup: { keyboard: rows, resize_keyboard: true, one_time_keyboard: true },
  });
}

async function askCategory(chatId) {
  await send(chatId, '<b>Что вам нужно?</b>', {
    reply_markup: { inline_keyboard: [CATEGORIES.map(([key, label]) => ({ text: label, callback_data: `cat:${key}` }))] },
  });
}

function summary(d) {
  return [
    `<b>Имя:</b> ${escapeHtml(d.name)}`,
    `<b>Контакт:</b> ${escapeHtml(d.contact)}`,
    `<b>Направление:</b> ${escapeHtml(d.category)}`,
    `<b>Запрос:</b> ${escapeHtml(d.request)}`,
  ].join('\n');
}

async function onMessage(m) {
  if (m.chat.type !== 'private' || m.from?.is_bot) return;
  const chatId = m.chat.id;
  const text = (m.text ?? '').trim();

  if (text === '/start' || text.startsWith('/start ') || text === '/new') return startDialog(chatId, m.from);

  const s = await getSession(chatId);
  if (!s) {
    // Диалог не идёт: если у человека уже есть открытая заявка — дописываем к ней, а не плодим дубли
    const lead = await findOpenLeadByTgUser(m.from.id, 'bot');
    if (lead) {
      await appendMessage(lead.id, describe(m), 'in');
      return send(chatId, `Добавил сообщение к вашей заявке №${lead.id}. Менеджер скоро ответит.\nНовая заявка — /new`);
    }
    return startDialog(chatId, m.from);
  }

  const d = s.data;
  switch (s.step) {
    case 'name':
      if (!text) return send(chatId, 'Напишите, пожалуйста, имя текстом.');
      d.name = text.slice(0, 100);
      await setSession(chatId, 'contact', d);
      return askContact(chatId, d);

    case 'contact': {
      const contact = m.contact ? `+${m.contact.phone_number.replace(/^\+/, '')}` : text;
      if (!contact) return askContact(chatId, d);
      d.contact = contact.slice(0, 100);
      await setSession(chatId, 'category', d);
      await send(chatId, 'Спасибо!', { reply_markup: { remove_keyboard: true } });
      return askCategory(chatId);
    }

    case 'category':
      // Текст вместо кнопки — не теряем: считаем направлением «Другое» и сразу запросом
      if (!text) return askCategory(chatId);
      d.category = 'Другое';
      d.request = text.slice(0, 2000);
      await setSession(chatId, 'confirm', d);
      return askConfirm(chatId, d);

    case 'request':
      if (!text) return send(chatId, 'Опишите задачу текстом, пожалуйста.');
      d.request = text.slice(0, 2000);
      await setSession(chatId, 'confirm', d);
      return askConfirm(chatId, d);

    case 'confirm':
      return send(chatId, 'Проверьте заявку выше и нажмите «Отправить» или «Заново».');
  }
}

function askConfirm(chatId, d) {
  return send(chatId, `Проверьте заявку:\n\n${summary(d)}`, {
    reply_markup: {
      inline_keyboard: [[
        { text: '✅ Отправить', callback_data: 'confirm' },
        { text: '↩️ Заново', callback_data: 'restart' },
      ]],
    },
  });
}

async function onCallback(cb) {
  await tg('answerCallbackQuery', { callback_query_id: cb.id });
  const msg = cb.message;
  if (!msg) return;
  const chatId = msg.chat.id;
  const s = await getSession(chatId);

  if (cb.data === 'restart') {
    await tg('editMessageReplyMarkup', { chat_id: chatId, message_id: msg.message_id });
    return startDialog(chatId, cb.from);
  }

  if (cb.data.startsWith('cat:') && s?.step === 'category') {
    const label = CATEGORIES.find(([key]) => `cat:${key}` === cb.data)?.[1] ?? 'Другое';
    s.data.category = label;
    await setSession(chatId, 'request', s.data);
    await tg('editMessageText', { chat_id: chatId, message_id: msg.message_id, text: `Направление: ${label}` });
    return send(chatId, '<b>Опишите задачу</b> в паре предложений: что нужно, сроки, бюджет — если есть.');
  }

  if (cb.data === 'confirm' && s?.step === 'confirm') {
    const d = s.data;
    const lead = await createLead({
      name: d.name,
      contact: d.contact,
      request: d.request,
      source: 'bot',
      tgUserId: cb.from.id,
      tgUsername: cb.from.username ?? null,
      tags: [BOT_TAG, d.category],
    });
    await clearSession(chatId);
    await tg('editMessageText', {
      chat_id: chatId,
      message_id: msg.message_id,
      parse_mode: 'HTML',
      text: `${summary(d)}\n\n✅ <b>Заявка №${lead.id} принята.</b> Менеджер свяжется с вами в ближайшее время.`,
    });
  }
}

// ---------- Пункт 2: личный Telegram через Telegram Business ----------

async function onBusinessConnection(c) {
  await q(
    `INSERT INTO business_connections (id, user_id, is_enabled, updated_at) VALUES ($1, $2, $3, now())
     ON CONFLICT (id) DO UPDATE SET user_id = EXCLUDED.user_id, is_enabled = EXCLUDED.is_enabled, updated_at = now()`,
    [c.id, c.user.id, c.is_enabled],
  );
}

async function ownerOf(connectionId) {
  const [row] = await q('SELECT user_id FROM business_connections WHERE id = $1', [connectionId]);
  if (row) return String(row.user_id);
  // Апдейт о подключении мог потеряться (например, бот был выключен) — спросим у Telegram
  const c = await tg('getBusinessConnection', { business_connection_id: connectionId });
  if (!c) return null;
  await onBusinessConnection(c);
  return String(c.user.id);
}

async function onBusinessMessage(m) {
  if (m.chat.type !== 'private') return;
  const owner = await ownerOf(m.business_connection_id);
  const client = m.chat; // в личке chat — это собеседник владельца аккаунта
  const text = describe(m);
  const isOutgoing = owner !== null && String(m.from?.id) === owner;

  let lead = await findOpenLeadByTgUser(client.id, 'tg_personal');

  if (isOutgoing) {
    // Ответ менеджера из своего Telegram: в историю лида, новых лидов не создаём
    if (lead) await appendMessage(lead.id, text, 'out');
    return;
  }
  if (m.from?.is_bot) return;

  if (!lead) {
    lead = await createLead({
      name: [client.first_name, client.last_name].filter(Boolean).join(' '),
      contact: client.username ? `@${client.username}` : `tg id ${client.id}`,
      request: text,
      source: 'tg_personal',
      tgUserId: client.id,
      tgUsername: client.username ?? null,
      tags: [PERSONAL_TAG],
    });
  }
  await appendMessage(lead.id, text, 'in');
}
