import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initDb } from './db.js';
import { tg, ALLOWED_UPDATES } from './tg.js';
import { handleUpdate } from './bot.js';
import * as leads from './leads.js';

const PORT = process.env.PORT || 3000;
const PUBLIC_URL = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
// Telegram принимает в secret_token только A-Z a-z 0-9 _ -, а Render генерирует base64 (+/=).
// Поэтому любой исходный секрет прогоняем через sha256 → hex
const WEBHOOK_SECRET = crypto
  .createHash('sha256')
  .update(`webhook:${process.env.WEBHOOK_SECRET || BOT_TOKEN}`)
  .digest('hex')
  .slice(0, 32);
const SESSION_TOKEN = crypto.createHash('sha256').update(`crm:${ADMIN_PASSWORD}:${WEBHOOK_SECRET}`).digest('hex');

let botUsername = null;

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public')));

app.get('/healthz', (_req, res) => {
  ensureWebhook().catch(() => {});
  res.send('ok');
});

// ---------- Telegram webhook ----------

app.post('/tg/webhook/:secret', async (req, res) => {
  if (req.params.secret !== WEBHOOK_SECRET || req.get('x-telegram-bot-api-secret-token') !== WEBHOOK_SECRET) {
    return res.sendStatus(403);
  }
  try {
    await handleUpdate(req.body);
  } catch (e) {
    // Отвечаем 200 в любом случае: иначе Telegram будет бесконечно повторять «битый» апдейт
    console.error('update failed', e);
  }
  res.sendStatus(200);
});

// ---------- Авторизация: один общий пароль ----------

function readCookie(req, name) {
  const m = (req.get('cookie') || '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : null;
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

app.post('/api/login', (req, res) => {
  if (ADMIN_PASSWORD && !safeEqual(req.body?.password ?? '', ADMIN_PASSWORD)) {
    return res.status(401).json({ error: 'Неверный пароль' });
  }
  const secure = PUBLIC_URL.startsWith('https') ? '; Secure' : '';
  res.set('set-cookie', `crm=${SESSION_TOKEN}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${secure}`);
  res.json({ ok: true });
});

app.post('/api/logout', (_req, res) => {
  res.set('set-cookie', 'crm=; Path=/; HttpOnly; Max-Age=0');
  res.json({ ok: true });
});

app.use('/api', (req, res, next) => {
  if (!ADMIN_PASSWORD || safeEqual(readCookie(req, 'crm') ?? '', SESSION_TOKEN)) return next();
  res.status(401).json({ error: 'Требуется вход' });
});

// ---------- CRM API ----------

const leadId = (req) => Number.parseInt(req.params.id, 10);

app.get('/api/me', (_req, res) => res.json({ ok: true, bot: botUsername }));

app.get('/api/leads', async (req, res) => {
  const { tag, source, q: search } = req.query;
  res.json(await leads.listLeads({ tag, source, search }));
});

app.get('/api/leads/:id', async (req, res) => {
  const lead = await leads.getLead(leadId(req));
  lead ? res.json(lead) : res.sendStatus(404);
});

app.post('/api/leads', async (req, res) => {
  const { name = '', contact = '', request = '', tags = [] } = req.body ?? {};
  if (!String(name).trim() && !String(contact).trim()) {
    return res.status(400).json({ error: 'Укажите имя или контакт' });
  }
  const lead = await leads.createLead({
    name: String(name).trim(),
    contact: String(contact).trim(),
    request: String(request).trim(),
    source: 'manual',
    tags: Array.isArray(tags) ? tags : [],
  });
  res.status(201).json(await leads.getLead(lead.id));
});

app.patch('/api/leads/:id', async (req, res) => {
  const lead = await leads.updateLead(leadId(req), req.body ?? {});
  lead ? res.json(lead) : res.sendStatus(404);
});

app.delete('/api/leads/:id', async (req, res) => {
  await leads.deleteLead(leadId(req));
  res.sendStatus(204);
});

app.post('/api/leads/:id/tags', async (req, res) => {
  const tag = await leads.addTag(leadId(req), req.body?.name);
  if (!tag) return res.status(400).json({ error: 'Пустой тег' });
  res.json(await leads.getLead(leadId(req)));
});

app.delete('/api/leads/:id/tags/:tagId', async (req, res) => {
  await leads.removeTag(leadId(req), Number.parseInt(req.params.tagId, 10));
  res.json(await leads.getLead(leadId(req)));
});

app.get('/api/tags', async (_req, res) => res.json(await leads.listTags()));

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Внутренняя ошибка' });
});

// ---------- Запуск ----------

// Webhook проверяем не только при старте: если его кто-то снял (другой экземпляр, getUpdates),
// бот замолчит, а спящий free-инстанс сам не проснётся. Render дёргает /healthz — заодно чиним.
let webhookCheckedAt = 0;
async function ensureWebhook(force = false) {
  if (!BOT_TOKEN || !PUBLIC_URL || process.env.POLLING === '1') return;
  if (!force && Date.now() - webhookCheckedAt < 10 * 60 * 1000) return;
  webhookCheckedAt = Date.now();
  const url = `${PUBLIC_URL}/tg/webhook/${WEBHOOK_SECRET}`;
  const info = await tg('getWebhookInfo');
  if (info?.url === url) return;
  const ok = await tg('setWebhook', { url, secret_token: WEBHOOK_SECRET, allowed_updates: ALLOWED_UPDATES });
  console.log(ok ? `Бот @${botUsername}: webhook установлен` : 'Не удалось установить webhook');
}

async function startPolling() {
  await tg('deleteWebhook');
  let offset = 0;
  console.log('Бот: режим getUpdates');
  for (;;) {
    const updates = await tg('getUpdates', { offset, timeout: 25, allowed_updates: ALLOWED_UPDATES }).catch(() => null);
    for (const u of updates ?? []) {
      offset = u.update_id + 1;
      await handleUpdate(u).catch((e) => console.error('update failed', e));
    }
    if (!updates) await new Promise((r) => setTimeout(r, 3000));
  }
}

await initDb();
app.listen(PORT, () => console.log(`CRM: http://localhost:${PORT}`));

if (BOT_TOKEN) {
  botUsername = (await tg('getMe'))?.username ?? null;
  if (process.env.POLLING === '1') {
    startPolling();
  } else if (PUBLIC_URL) {
    await ensureWebhook(true);
  } else {
    console.warn('Нет PUBLIC_URL и POLLING!=1 — бот не получает апдейты');
  }
} else {
  console.warn('BOT_TOKEN не задан — бот выключен, работает только CRM');
}
