import { q } from './db.js';

export const SOURCES = ['bot', 'tg_personal', 'manual'];
export const STATUSES = ['new', 'in_work', 'done', 'lost'];
const OPEN_STATUSES = ['new', 'in_work'];

const COLORS = ['#2563eb', '#16a34a', '#d97706', '#dc2626', '#7c3aed', '#0891b2', '#db2777', '#65a30d'];

const LEAD_SELECT = `
  SELECT l.*,
    COALESCE(
      json_agg(json_build_object('id', t.id, 'name', t.name, 'color', t.color) ORDER BY t.name)
        FILTER (WHERE t.id IS NOT NULL),
      '[]'
    ) AS tags,
    (SELECT count(*)::int FROM messages m WHERE m.lead_id = l.id) AS message_count
  FROM leads l
  LEFT JOIN lead_tags lt ON lt.lead_id = l.id
  LEFT JOIN tags t ON t.id = lt.tag_id`;

export function normalizeTag(name) {
  return String(name ?? '').trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 40);
}

function colorFor(name) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return COLORS[h % COLORS.length];
}

export async function listLeads({ tag, source, search } = {}) {
  const where = [];
  const params = [];
  if (tag) {
    params.push(normalizeTag(tag));
    where.push(`l.id IN (SELECT lt2.lead_id FROM lead_tags lt2 JOIN tags t2 ON t2.id = lt2.tag_id WHERE t2.name = $${params.length})`);
  }
  if (source) {
    params.push(source);
    where.push(`l.source = $${params.length}`);
  }
  if (search) {
    params.push(`%${search}%`);
    const p = `$${params.length}`;
    where.push(`(l.name ILIKE ${p} OR l.contact ILIKE ${p} OR l.request ILIKE ${p})`);
  }
  return q(
    `${LEAD_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     GROUP BY l.id ORDER BY l.updated_at DESC LIMIT 500`,
    params,
  );
}

export async function getLead(id) {
  const [lead] = await q(`${LEAD_SELECT} WHERE l.id = $1 GROUP BY l.id`, [id]);
  if (!lead) return null;
  lead.messages = await q('SELECT * FROM messages WHERE lead_id = $1 ORDER BY created_at, id', [id]);
  return lead;
}

export async function createLead({ name = '', contact = '', request = '', source, tgUserId = null, tgUsername = null, tags = [] }) {
  const [lead] = await q(
    `INSERT INTO leads (name, contact, request, source, tg_user_id, tg_username)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [name.slice(0, 200), contact.slice(0, 200), request.slice(0, 4000), source, tgUserId, tgUsername],
  );
  for (const t of tags) await addTag(lead.id, t);
  return lead;
}

export async function updateLead(id, fields) {
  const allowed = ['name', 'contact', 'request', 'status'];
  const sets = [];
  const params = [];
  for (const key of allowed) {
    if (fields[key] === undefined) continue;
    if (key === 'status' && !STATUSES.includes(fields[key])) continue;
    params.push(String(fields[key]));
    sets.push(`${key} = $${params.length}`);
  }
  if (sets.length) {
    params.push(id);
    await q(`UPDATE leads SET ${sets.join(', ')}, updated_at = now() WHERE id = $${params.length}`, params);
  }
  return getLead(id);
}

export async function deleteLead(id) {
  await q('DELETE FROM leads WHERE id = $1', [id]);
}

/** Последний открытый лид этого Telegram-пользователя из данного канала. */
export async function findOpenLeadByTgUser(tgUserId, source) {
  const [lead] = await q(
    `SELECT * FROM leads WHERE tg_user_id = $1 AND source = $2 AND status = ANY($3)
     ORDER BY created_at DESC LIMIT 1`,
    [tgUserId, source, OPEN_STATUSES],
  );
  return lead ?? null;
}

export async function appendMessage(leadId, text, direction) {
  await q('INSERT INTO messages (lead_id, text, direction) VALUES ($1, $2, $3)', [leadId, text.slice(0, 4000), direction]);
  await q('UPDATE leads SET updated_at = now() WHERE id = $1', [leadId]);
}

export async function addTag(leadId, rawName) {
  const name = normalizeTag(rawName);
  if (!name) return null;
  const [tag] = await q(
    `INSERT INTO tags (name, color) VALUES ($1, $2)
     ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING *`,
    [name, colorFor(name)],
  );
  await q('INSERT INTO lead_tags (lead_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [leadId, tag.id]);
  return tag;
}

export async function removeTag(leadId, tagId) {
  await q('DELETE FROM lead_tags WHERE lead_id = $1 AND tag_id = $2', [leadId, tagId]);
}

export async function listTags() {
  return q(
    `SELECT t.*, count(lt.lead_id)::int AS lead_count
     FROM tags t LEFT JOIN lead_tags lt ON lt.tag_id = t.id
     GROUP BY t.id ORDER BY lead_count DESC, t.name`,
  );
}
