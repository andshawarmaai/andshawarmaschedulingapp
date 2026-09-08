-- &Shawarma staff app — Postgres schema (Neon).
-- Run this once against a fresh database, then `node db/seed.mjs` to create
-- the first admin account.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  username      TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  display_name  TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('staff', 'manager', 'admin')),
  email         TEXT,
  phone         TEXT,
  disabled      BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS shift_imports (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  uploaded_by   TEXT REFERENCES users(id) ON DELETE SET NULL,
  filename      TEXT,
  row_count     INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS shifts (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id       TEXT REFERENCES users(id) ON DELETE SET NULL,
  date          TEXT NOT NULL, -- 'YYYY-MM-DD'
  start_time    TEXT NOT NULL, -- 'HH:MM', 24h
  end_time      TEXT NOT NULL,
  department    TEXT,          -- 'FOH' | 'BOH' | NULL
  notes         TEXT,
  import_id     TEXT REFERENCES shift_imports(id) ON DELETE CASCADE, -- set when created by a bulk CSV import; deleting the import undoes its shifts
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS shifts_date_idx ON shifts (date);
CREATE INDEX IF NOT EXISTS shifts_user_idx ON shifts (user_id);
CREATE INDEX IF NOT EXISTS shifts_import_idx ON shifts (import_id);

CREATE TABLE IF NOT EXISTS time_off_requests (
  id             TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  start_date     TEXT NOT NULL, -- 'YYYY-MM-DD'
  end_date       TEXT NOT NULL, -- 'YYYY-MM-DD'
  reason         TEXT,
  status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied')),
  denial_reason  TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS time_off_user_idx ON time_off_requests (user_id);

CREATE TABLE IF NOT EXISTS swap_posts (
  id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  shift_id    TEXT NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason      TEXT,
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'cancelled', 'closed')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS swap_claims (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  post_id         TEXT NOT NULL REFERENCES swap_posts(id) ON DELETE CASCADE,
  claimant_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  offer_shift_id  TEXT REFERENCES shifts(id) ON DELETE SET NULL,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS shift_requests (
  id             TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action         TEXT NOT NULL CHECK (action IN ('create', 'update', 'delete')),
  shift_id       TEXT REFERENCES shifts(id) ON DELETE CASCADE, -- null for 'create'
  date           TEXT, -- 'YYYY-MM-DD'
  start_time     TEXT,
  end_time       TEXT,
  department     TEXT,
  notes          TEXT,
  status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied')),
  denial_reason  TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS shift_requests_user_idx ON shift_requests (user_id);

-- API keys for programmatic access (e.g. an AI agent posting a bulk shift
-- import CSV). Keys are shown in full exactly once at creation, then only
-- the hash + a short identifying prefix are kept — same pattern as a
-- password. Revoking one doesn't touch any other key.
CREATE TABLE IF NOT EXISTS api_keys (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  label         TEXT NOT NULL,
  key_prefix    TEXT NOT NULL,
  key_hash      TEXT NOT NULL,
  created_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at  TIMESTAMPTZ,
  revoked       BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS api_keys_prefix_idx ON api_keys (key_prefix);

-- A staff member can't reset their own password (there's no email sender
-- configured), so "Forgot password?" on the login screen files a request
-- here instead — it shows up as a pending item admin sees on the
-- dashboard, same as any other approval.
CREATE TABLE IF NOT EXISTS password_reset_requests (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  requested_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at   TIMESTAMPTZ,
  resolved_by   TEXT REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS password_reset_user_idx ON password_reset_requests (user_id);

-- One row per admin's personal Telegram bot (separate bots per admin, not
-- one shared bot — easy to revoke one person without touching anyone
-- else's). bot_token is Telegram's own secret, needed in plaintext to call
-- their Bot API (sendMessage, setWebhook) — unlike api_keys, this isn't a
-- credential we issue and can hash, it's one we hold and use. webhook_secret
-- is ours: a random value Telegram echoes back on every webhook call
-- (X-Telegram-Bot-Api-Secret-Token), checked so a request to the (already
-- hard-to-guess, UUID-keyed) webhook URL can't be spoofed by anyone who
-- finds the URL some other way. chat_id is null until the admin sends
-- /start to their own bot — until then, nobody is treated as authorized.
CREATE TABLE IF NOT EXISTS telegram_bots (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bot_token       TEXT NOT NULL,
  bot_username    TEXT,
  webhook_secret  TEXT NOT NULL,
  chat_id         TEXT,
  linked_at       TIMESTAMPTZ,
  last_used_at    TIMESTAMPTZ,
  revoked         BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS telegram_bots_user_idx ON telegram_bots (user_id);

CREATE TABLE IF NOT EXISTS day_caps (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  date          TEXT NOT NULL, -- 'YYYY-MM-DD'
  window_start  TEXT NOT NULL,
  window_end    TEXT NOT NULL,
  max_shifts    INTEGER NOT NULL,
  note          TEXT,
  UNIQUE (date, window_start, window_end)
);
