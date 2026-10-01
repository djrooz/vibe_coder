# Мини-CRM для заявок агентства

Лиды собираются из трёх каналов в одну таблицу с тегами:

1. **Telegram-бот.** Пошагово собирает имя, контакт, направление и запрос, после чего создаётся лид с автотегами `telegram-бот` и направлением.
2. **Личный Telegram (Telegram Business).** Бот подключается к личному аккаунту, и входящие сообщения становятся лидами с тегом `telegram-личный`. Ответы владельца аккаунта сохраняются в переписке лида.
3. **Вручную.** Кнопка «+ Лид» в CRM.

Теги можно добавлять и удалять в карточке лида. Фильтр по тегу работает через боковую панель или клик по тегу в списке.

## Как устроено

```
Telegram ──webhook──▶ /tg/webhook/:secret ──▶ bot.js (диалог, Business) ──┐
CRM (public/index.html) ──REST /api/*──▶ server.js ──▶ leads.js ──▶ Postgres (Neon)
```

- `src/server.js`: Express, REST API, вход по паролю, webhook и установка webhook при старте.
- `src/bot.js`: диалог-заявка (состояние в таблице `bot_sessions`, поэтому переживает засыпание сервера) и обработка `business_message`.
- `src/leads.js`: лиды, теги, переписка.
- `src/db.js`: схема БД, которая создаётся при старте. Без `DATABASE_URL` используется встроенный PGlite.
- `public/index.html`: весь интерфейс CRM, ванильный JS без сборки. Обновляется опросом каждые 5 секунд.

## Запуск локально

```bash
npm install
BOT_TOKEN=... POLLING=1 npm start   # бот через getUpdates, БД в памяти
```

## Деплой (Render + Neon)

1. Создать базу в [Neon](https://neon.tech) и скопировать connection string.
2. На [Render](https://render.com): New → Blueprint и выбрать этот репозиторий (`render.yaml`).
3. Задать `BOT_TOKEN`, `DATABASE_URL`, `ADMIN_PASSWORD`. Webhook установится сам на `RENDER_EXTERNAL_URL`.

Подключение личного Telegram (нужен Telegram Premium): Настройки → Telegram для бизнеса → Чат-боты → указать бота.
