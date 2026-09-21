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

-- Admin-only priority tiers (e.g. "Tier 1", "Tier 2") used to cap how many
-- shifts/days-off a staff member can be granted per calendar month. Never
-- exposed to the assigned staff member — only admin sees a user's tier or
-- the tier list at all (see src/pages/api/state.js: gated to role='admin',
-- not the usual admin-or-manager check). A NULL limit column means "no cap
-- for that dimension" — a tier doesn't have to define all four.
CREATE TABLE IF NOT EXISTS tiers (
  id                              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name                            TEXT NOT NULL,
  max_shifts_per_month            INTEGER,
  max_weekend_shifts_per_month    INTEGER,
  max_days_off_per_month          INTEGER,
  max_weekend_days_off_per_month  INTEGER,
  -- When true, a time-off request from someone on this tier that's within
  -- the tier's own caps above is approved immediately instead of landing
  -- pending for admin review. Still never approves through a staffing
  -- conflict (see checkTimeOffCoverage) — a coverage gap always goes to
  -- pending regardless of this flag, same as it would for any other tier.
  auto_approve_time_off           BOOLEAN NOT NULL DEFAULT FALSE,
  created_at                      TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE tiers ADD COLUMN IF NOT EXISTS auto_approve_time_off BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE users ADD COLUMN IF NOT EXISTS tier_id TEXT REFERENCES tiers(id) ON DELETE SET NULL;

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
-- Sprint 3: which job/role this shift fills — nullable so every existing
-- and manually-created shift (job-agnostic, just "you're on the schedule")
-- keeps working untouched. The auto-generation optimizer always sets this;
-- it's what lets Sprint 2's peak-staffing-mix check attribute a specific
-- assigned person to a specific job requirement directly, instead of the
-- "count every qualified job the assignee has" fallback coverage-check.js
-- uses today for shifts with no job_id.
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS time_off_requests (
  id                TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  start_date        TEXT NOT NULL, -- 'YYYY-MM-DD'
  end_date          TEXT NOT NULL, -- 'YYYY-MM-DD'
  reason            TEXT,
  status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied')),
  denial_reason     TEXT,
  -- Set when granting this would drop a covered shift below its defined
  -- minimum staffing (see shift_templates below) — shown to whoever's
  -- deciding, never auto-denies like a tier limit does.
  staffing_warning  TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS time_off_user_idx ON time_off_requests (user_id);
-- CREATE TABLE IF NOT EXISTS above is a no-op against an existing table,
-- so a column added to it after that table already exists in production
-- (staffing_warning was) needs its own ALTER TABLE to actually apply.
ALTER TABLE time_off_requests ADD COLUMN IF NOT EXISTS staffing_warning TEXT;

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
  id                TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action            TEXT NOT NULL CHECK (action IN ('create', 'update', 'delete')),
  shift_id          TEXT REFERENCES shifts(id) ON DELETE CASCADE, -- null for 'create'
  date              TEXT, -- 'YYYY-MM-DD'
  start_time        TEXT,
  end_time          TEXT,
  department        TEXT,
  notes             TEXT,
  status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied')),
  denial_reason     TEXT,
  staffing_warning  TEXT, -- see time_off_requests.staffing_warning above
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS shift_requests_user_idx ON shift_requests (user_id);
ALTER TABLE shift_requests ADD COLUMN IF NOT EXISTS staffing_warning TEXT;

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

-- Date-specific override/exception on top of a recurring shift_template
-- below (holiday, one-off event, etc.) — unrelated recurring coverage
-- lives in shift_templates; this is only for a single calendar date.
CREATE TABLE IF NOT EXISTS day_caps (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  date          TEXT NOT NULL, -- 'YYYY-MM-DD'
  window_start  TEXT NOT NULL,
  window_end    TEXT NOT NULL,
  max_shifts    INTEGER NOT NULL,
  note          TEXT,
  UNIQUE (date, window_start, window_end)
);

-- ============================================================
-- Sprint 1 (ResOpsBuddy Scheduling PRD v0.2): multi-location foundation,
-- jobs/roles + qualification, role-specific proficiency, and recurring
-- availability. See EPIC 1-4 in the PRD for the full rationale — this is
-- the MVP-scoped slice of that domain model, added on top of the proven
-- &Shawarma app rather than replacing any of it.

-- Multi-location by design (PRD principle 1.2), even though every existing
-- row so far belongs to one restaurant — a location_id column added to an
-- existing table is nullable so nothing already in production breaks; a
-- NULL location means "the single default location" until an admin
-- actually splits locations apart.
CREATE TABLE IF NOT EXISTS locations (
  id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name        TEXT NOT NULL,
  timezone    TEXT NOT NULL DEFAULT 'America/New_York',
  disabled    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS location_id TEXT REFERENCES locations(id) ON DELETE SET NULL;
-- GPS-verified self check-in: a location has no coordinates until an
-- admin sets them (Manage → Location Check-In) — geofence_radius_meters
-- staying NULL means "not configured yet," distinct from a real 0, so
-- /api/checkin can tell "nobody's set this up" apart from "set up with a
-- zero-radius geofence."
ALTER TABLE locations ADD COLUMN IF NOT EXISTS lat DOUBLE PRECISION;
ALTER TABLE locations ADD COLUMN IF NOT EXISTS lng DOUBLE PRECISION;
ALTER TABLE locations ADD COLUMN IF NOT EXISTS geofence_radius_meters INTEGER;

-- A job/role is a named operational position ("Shawarma Station", "Cashier",
-- "Line Cook") — distinct from users.role (staff/manager/admin, an
-- app-permission level, not a station). Existing shifts.department stays as
-- the free-text FOH/BOH label; jobs are a new, more specific concept layered
-- on top, not a replacement for it.
CREATE TABLE IF NOT EXISTS jobs (
  id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name        TEXT NOT NULL,
  department  TEXT,
  disabled    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Whether an employee is allowed to work a job at all. Only 'qualified'
-- satisfies a hard job requirement (PRD WB-SCH-202) — 'training' means
-- they're learning it but shouldn't be relied on solo yet, and is tracked
-- separately from role-specific proficiency below (qualification is a gate;
-- proficiency is a preference signal on top of an already-qualified
-- employee). One row per user+job — re-saving updates it in place rather
-- than keeping a full history, an MVP simplification the PRD's own P1
-- scope revisits later ("automated performance signals... over time").
CREATE TABLE IF NOT EXISTS employee_jobs (
  id                    TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id               TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_id                TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  qualification_state   TEXT NOT NULL DEFAULT 'training' CHECK (qualification_state IN ('not_qualified', 'training', 'qualified')),
  effective_date        TEXT NOT NULL,
  created_by            TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, job_id)
);
CREATE INDEX IF NOT EXISTS employee_jobs_user_idx ON employee_jobs (user_id);

-- Role-specific proficiency (PRD EPIC 3 / section 4.2) — deliberately NOT a
-- single global "good/bad employee" score. Tracked per job, with an
-- effective date and the admin who set it, so it stays reviewable and
-- correctable rather than an opaque number. Requires the employee already
-- be 'qualified' on employee_jobs for this job — proficiency ranks among
-- eligible people, it never substitutes for eligibility.
CREATE TABLE IF NOT EXISTS employee_role_profiles (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_id          TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  proficiency     TEXT NOT NULL CHECK (proficiency IN ('developing', 'proficient', 'advanced')),
  effective_date  TEXT NOT NULL,
  source          TEXT, -- free text, e.g. 'Manager review 2026-09' — never a hidden/derived number for MVP
  created_by      TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, job_id)
);
CREATE INDEX IF NOT EXISTS employee_role_profiles_user_idx ON employee_role_profiles (user_id);

-- Recurring weekly availability (PRD EPIC 4 / WB-SCH-301) — distinct from
-- time_off_requests, which is date-specific. "I'm never available Tuesdays"
-- belongs here; "I need next Tuesday off" belongs in time_off_requests.
-- Multiple rows per day are allowed (e.g. available 9-12 and 4-9 the same
-- day) — day_of_week follows JS's Date#getDay() convention (0=Sun..6=Sat)
-- to match isWeekend()'s existing convention in tierLimits.js.
CREATE TABLE IF NOT EXISTS availability_rules (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day_of_week     INTEGER NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  start_time      TEXT NOT NULL,
  end_time        TEXT NOT NULL,
  effective_from  TEXT, -- NULL = no start bound
  effective_to    TEXT, -- NULL = ongoing
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS availability_rules_user_idx ON availability_rules (user_id);

-- Recurring weekly shift blocks — the reusable "9am-9pm", "4:30pm-2:30am"
-- style templates an admin defines once instead of retyping raw times
-- every time they schedule someone. days_of_week is a comma-separated
-- list of 0-6 (Sun=0..Sat=6) the block applies to, so the same business
-- can have a different late-night block on Fri/Sat than the rest of the
-- week without two separate concepts. start_time > end_time means the
-- block crosses midnight (e.g. '16:30'/'02:30') — `date` on an actual
-- shifts row is always the day the block STARTS.
-- min_staff/max_staff are both optional (NULL = no requirement on that
-- side): min_staff drives the staffing_warning flag on a request that
-- would remove someone from a covered shift (see src/lib/coverage.js);
-- max_staff is an ongoing version of day_caps' one-off max, shown
-- alongside any day_caps override for the same window on the calendar.
CREATE TABLE IF NOT EXISTS shift_templates (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name          TEXT NOT NULL,
  days_of_week  TEXT NOT NULL, -- e.g. '1,2,3,4' or '5,6'
  start_time    TEXT NOT NULL,
  end_time      TEXT NOT NULL,
  min_staff     INTEGER,
  max_staff     INTEGER,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- Sprint 2 (ResOpsBuddy Scheduling PRD v0.2, EPIC 3/5): peak staffing mix
-- — "Friday dinner needs at least one Advanced shawarma person and three
-- Proficient+ people" (PRD section 4.2 / WB-SCH-253). One row per
-- template+job: min_count is the plain headcount requirement for that job
-- on that template (same spirit as shift_templates.min_staff, but scoped
-- to a specific job rather than the template's total headcount);
-- min_advanced_count and min_proficient_or_better_count are layered on
-- top of it — both optional, both never exceeding min_count in practice
-- (not enforced by a constraint since that policy call belongs to
-- whoever's configuring it, not the schema).
CREATE TABLE IF NOT EXISTS template_job_requirements (
  id                              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  shift_template_id               TEXT NOT NULL REFERENCES shift_templates(id) ON DELETE CASCADE,
  job_id                          TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  min_count                       INTEGER NOT NULL DEFAULT 0,
  min_advanced_count              INTEGER NOT NULL DEFAULT 0,
  min_proficient_or_better_count  INTEGER NOT NULL DEFAULT 0,
  created_at                      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (shift_template_id, job_id)
);
CREATE INDEX IF NOT EXISTS template_job_requirements_template_idx ON template_job_requirements (shift_template_id);

-- ============================================================
-- Sprint 4 (ResOpsBuddy Scheduling PRD v0.2, EPIC 7): versioning + audit
-- for the auto-generation feature specifically. This app has never had a
-- draft/published state machine for shifts — every manually-created shift
-- has always been immediately live, and that stays true; retrofitting a
-- full DRAFT->PUBLISHED lifecycle onto the entire existing shifts model
-- is a much larger, riskier change than the PRD's actual concern for this
-- app: the NEW bulk/automated generate-and-apply path is exactly where an
-- immutable "what did the optimizer propose, and what did a human actually
-- accept" record matters most, so that's what this adds.
--
-- One row per .../schedule/generate + .../apply pair: the full proposal
-- (every candidate assignment and every unfilled gap, as returned to the
-- manager) plus which of those assignments were actually applied and by
-- whom. Immutable once written — an "undo" is a manual delete of the
-- created shifts, same as undoing any other manually-created shift; this
-- table only needs to answer "what did the system propose, on this date,
-- and did a human accept it," not own the shifts' own lifecycle.
CREATE TABLE IF NOT EXISTS schedule_generations (
  id                TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  date              TEXT NOT NULL, -- 'YYYY-MM-DD' the proposal was generated for
  generated_by      TEXT REFERENCES users(id) ON DELETE SET NULL,
  proposal          JSONB NOT NULL, -- the full { slots, assignments, unfilled } the manager saw
  applied_shift_ids TEXT,           -- comma-separated shift ids actually created, NULL if never applied
  applied_by        TEXT REFERENCES users(id) ON DELETE SET NULL,
  applied_at        TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS schedule_generations_date_idx ON schedule_generations (date);

-- ============================================================
-- Sprint 7 (ResOpsBuddy Scheduling PRD v0.2, EPIC 11 subset): actual
-- worked time, POS/timeclock-agnostic. No per-vendor adapter (Toast,
-- Square, Clover, ...) — each business's POS produces its own report
-- format, and this platform serves many different businesses, so the
-- translation step is the ingesting agent's job (see AGENT-TRAINING.md's
-- "a dropped-in file is yours to convert" principle, same pattern as the
-- existing shift-import path), not per-vendor code maintained here. This
-- table is the one canonical shape every business's actual-time data
-- lands in regardless of source system.
--
-- Deliberately separate from `shifts` (what was SCHEDULED) — comparing
-- the two is the whole point (was this person on time? did they show up
-- at all?), and overwriting a schedule row with actual data would destroy
-- that comparison. shift_id links back to the scheduled shift when one
-- honestly matches (same person, same date, overlapping window); NULL
-- means no matching scheduled shift was found — an unscheduled worked
-- shift is still worth recording, just flagged as such by the null.
CREATE TABLE IF NOT EXISTS actual_worked_shifts (
  id                TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  shift_id          TEXT REFERENCES shifts(id) ON DELETE SET NULL,
  date              TEXT NOT NULL, -- 'YYYY-MM-DD'
  clock_in          TEXT NOT NULL, -- 'HH:MM', 24h, local to the business
  clock_out         TEXT,          -- NULL if still clocked in / not yet closed out
  source            TEXT NOT NULL, -- free text, e.g. 'toast', 'square', 'clover' — whatever the agent was told the data came from
  external_ref      TEXT,          -- the source system's own id for this punch, when it has one
  import_id         TEXT REFERENCES shift_imports(id) ON DELETE CASCADE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source, external_ref)   -- NULLs don't conflict under this constraint (standard SQL), so a source with no stable id per punch just has no dedup guarantee — the same protection shift_imports already accepts for CSV rows with no natural key
);
CREATE INDEX IF NOT EXISTS actual_worked_shifts_user_date_idx ON actual_worked_shifts (user_id, date);
-- GPS-verified self check-in (source='self_checkin'): the raw coordinates
-- and computed distance from the location's geofence center, at both
-- punches — an audit trail, not just a pass/fail, so a disputed punch has
-- a real record of what was actually checked, not just "it passed."
-- NULL on every other source, since only a live self-check-in captures a
-- device's GPS reading at all.
ALTER TABLE actual_worked_shifts ADD COLUMN IF NOT EXISTS clock_in_lat DOUBLE PRECISION;
ALTER TABLE actual_worked_shifts ADD COLUMN IF NOT EXISTS clock_in_lng DOUBLE PRECISION;
ALTER TABLE actual_worked_shifts ADD COLUMN IF NOT EXISTS clock_in_distance_meters DOUBLE PRECISION;
ALTER TABLE actual_worked_shifts ADD COLUMN IF NOT EXISTS clock_out_lat DOUBLE PRECISION;
ALTER TABLE actual_worked_shifts ADD COLUMN IF NOT EXISTS clock_out_lng DOUBLE PRECISION;
ALTER TABLE actual_worked_shifts ADD COLUMN IF NOT EXISTS clock_out_distance_meters DOUBLE PRECISION;

-- ─── AI assistant settings ─────────────────────────────────────────────
-- Per-deployment AI provider config (key + which provider to use).
-- Encrypted at rest (AES-256-GCM with a key derived from SESSION_SECRET).
-- Read by the chat orchestrator at request time — no env vars or redeploys
-- needed when the admin changes providers or rotates a key.
CREATE TABLE IF NOT EXISTS app_settings (
  key             TEXT PRIMARY KEY,
  value_encrypted BYTEA NOT NULL,
  iv              BYTEA NOT NULL,
  auth_tag        BYTEA NOT NULL,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by      TEXT REFERENCES users(id) ON DELETE SET NULL
);

