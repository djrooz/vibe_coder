// Тонкая обёртка над Telegram Bot API: без фреймворка, только fetch
export const ALLOWED_UPDATES = ['message', 'callback_query', 'business_connection', 'business_message'];

export async function tg(method, body = {}) {
  const token = process.env.BOT_TOKEN;
  if (!token) throw new Error('BOT_TOKEN не задан');
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!json.ok) {
    console.error(`Telegram ${method}: ${json.description}`);
    return null;
  }
  return json.result;
}

export function send(chatId, text, extra = {}) {
  return tg('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', ...extra });
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
}
