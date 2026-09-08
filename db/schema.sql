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

CREATE TABLE IF NOT EXISTS shifts (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id       TEXT REFERENCES users(id) ON DELETE SET NULL,
  date          DATE NOT NULL,
  start_time    TEXT NOT NULL, -- 'HH:MM', 24h
  end_time      TEXT NOT NULL,
  department    TEXT,          -- 'FOH' | 'BOH' | NULL
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS shifts_date_idx ON shifts (date);
CREATE INDEX IF NOT EXISTS shifts_user_idx ON shifts (user_id);

CREATE TABLE IF NOT EXISTS time_off_requests (
  id             TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  start_date     DATE NOT NULL,
  end_date       DATE NOT NULL,
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

CREATE TABLE IF NOT EXISTS day_caps (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  date          DATE NOT NULL,
  window_start  TEXT NOT NULL,
  window_end    TEXT NOT NULL,
  max_shifts    INTEGER NOT NULL,
  note          TEXT,
  UNIQUE (date, window_start, window_end)
);
