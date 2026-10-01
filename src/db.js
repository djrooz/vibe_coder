import pg from 'pg';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS leads (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL DEFAULT '',
  contact     TEXT NOT NULL DEFAULT '',
  request     TEXT NOT NULL DEFAULT '',
  source      TEXT NOT NULL CHECK (source IN ('bot', 'tg_personal', 'manual')),
  status      TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'in_work', 'done', 'lost')),
  tg_user_id  BIGINT,
  tg_username TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS leads_tg_user_idx ON leads (tg_user_id, source);

CREATE TABLE IF NOT EXISTS messages (
  id         SERIAL PRIMARY KEY,
  lead_id    INT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  text       TEXT NOT NULL,
  direction  TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS messages_lead_idx ON messages (lead_id);

CREATE TABLE IF NOT EXISTS tags (
  id    SERIAL PRIMARY KEY,
  name  TEXT NOT NULL UNIQUE,
  color TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS lead_tags (
  lead_id INT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  tag_id  INT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (lead_id, tag_id)
);

-- Состояние диалога с ботом храним в БД: free-инстанс Render засыпает и теряет память
CREATE TABLE IF NOT EXISTS bot_sessions (
  chat_id    BIGINT PRIMARY KEY,
  step       TEXT NOT NULL,
  data       JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Подключения Telegram Business: чей личный аккаунт подключил бота
CREATE TABLE IF NOT EXISTS business_connections (
  id         TEXT PRIMARY KEY,
  user_id    BIGINT NOT NULL,
  is_enabled BOOLEAN NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

let db;

export async function initDb() {
  const url = process.env.DATABASE_URL;
  if (url) {
    const pool = new pg.Pool({ connectionString: url, max: 5 });
    db = { query: (text, params) => pool.query(text, params), exec: (text) => pool.query(text) };
  } else {
    // Локально без Postgres: тот же SQL в Postgres-on-WASM. Данные в памяти или в PGLITE_DIR
    const { PGlite } = await import('@electric-sql/pglite');
    const lite = new PGlite(process.env.PGLITE_DIR);
    db = { query: (text, params) => lite.query(text, params), exec: (text) => lite.exec(text) };
    console.warn('DATABASE_URL не задан — используется встроенный PGlite');
  }
  await db.exec(SCHEMA);
}

export async function q(text, params) {
  return (await db.query(text, params)).rows;
}
