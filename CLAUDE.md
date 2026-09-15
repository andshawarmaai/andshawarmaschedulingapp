# &Shawarma Scheduling App — Agent Reference

This file is the persistent source of truth for any agent working on or
integrating with this app — Claude Code, a future session of me, or an
external agent (e.g. one named "Hermes" with Vercel/API access). Read this
BEFORE exploring the codebase or asking the user how something works. It
should answer the schema, business-rule, and "how do I bulk-load data"
questions cold, so the same ground never has to be re-derived or re-asked.

**Keep this file current.** Any agent that changes the data model, adds a
business rule, adds a new bulk-import row type, or hits a new gotcha should
update the relevant section below in the same change — this document decays
fast if it's treated as a one-time snapshot instead of living documentation.

## If you're being asked to integrate with this app as an agent (Hermes, or similar)

**Read `AGENT-TRAINING.md` now, or better, fetch it live: `GET
/api/agent-guide/markdown` (human-readable) or `GET /api/agent-guide`
(JSON) — no auth required for either.** It's generated straight from
`src/lib/agentGuide/registry.js`, so it can't drift from what the API
actually does the way hand-written prose can; the committed
`AGENT-TRAINING.md` is a manually-refreshed snapshot of the same output for
offline reading. It documents every action you can take (submit
availability, create/move/delete a shift, manage templates, post/claim a
swap), which ones are human-only by design (approving or denying anything —
that's the whole point of the Schedule Builder's review queue), exact
request shapes, and the bulk-schedule-import path for loading a whole
week/month at once. **Prefer fetching it from the specific deployment
you're actually talking to** (§2 above has both URLs) since each has its
own data.

Authenticate with an API key (`Authorization: Bearer shwrm_xxxxx`, created
via `POST /api/admin/api-keys` or the Manage → API Keys card) — as of this
writing, an API key is resolved by `middleware.js` into the real user who
created it, with that user's exact role, for **every** `/api/*` route, not
just the bulk-import one. That means any route documented in
`AGENT-TRAINING.md` — or any new one added later — works for an API-key
caller automatically, with no per-route change required. Keep it that way:
if you ever add a new API route, you do not need to touch auth for it to
work for an agent, but you DO need to add it to `registry.js` and
regenerate `AGENT-TRAINING.md` so an agent knows it exists.

To regenerate `AGENT-TRAINING.md` after changing `registry.js`:
```bash
node -e "
import('./src/lib/agentGuide/build.js').then(async ({ buildAgentGuide }) => {
  const { renderAgentGuideMarkdown } = await import('./src/lib/agentGuide/markdown.js');
  console.log(renderAgentGuideMarkdown(buildAgentGuide(), { baseUrl: '' }));
});
" > /tmp/agent-training-body.md
```
then prepend the same generated-file header comment already at the top of
`AGENT-TRAINING.md` and overwrite it.

---

## 1. What this is

A single-restaurant staff scheduling app: Astro 5 (server output) + Vercel
+ Neon Postgres. Staff submit availability and time off; an admin/manager
builds the actual schedule and approves/denies everything from one place
(the Schedule Builder). There is no multi-tenant concept — one deployment
serves one restaurant's roster.

## 2. Deployment topology (important — there are two of everything)

This codebase is pushed to **two separate GitHub repos**, each deployed to
its **own Vercel project with its own Neon database**:

| | Repo | Vercel project | Live URL |
|---|---|---|---|
| Dev/test | `andshawarmaai/andshawarmaschedulingapp` (remote `origin`) | — | — |
| Customer-facing | `therayally/andshawarmatest` (no local remote configured by default — push via full URL) | `andshawarmatest` (`.vercel/project.json`) | https://andshawarmatest.vercel.app |

When you push code, push to **both**:
```bash
git push origin main
git push https://github.com/therayally/andshawarmatest.git main
```
Deploy with `vercel --prod --yes` from the repo root (it deploys+aliases
whichever Vercel project `.vercel/project.json` currently points at — that
file is already linked to `andshawarmatest`).

**Local dev never touches Neon.** `src/lib/db/index.js` picks the backend:
`DATABASE_URL` set → `neon.js` (real Postgres); unset → `local.js` (a JSON
file at `db/.local-data.json`, gitignored). This means **a bug can exist in
one backend and not the other** — see §6, both of this session's real bugs
were exactly that. Always sanity-check a data-writing change against both
`local.js` and `neon.js` if you touch `src/lib/db/*`.

Required env vars (`.env.example`): `DATABASE_URL` (Neon connection string,
omit for local JSON mode), `SESSION_SECRET` (app throws on boot in
production without it). See `HANDOFF.md` for deployment-troubleshooting
specifics (Vercel promotion, env var mismatches) from an earlier handoff —
that file is a point-in-time troubleshooting brief, this file is the living
reference.

`npm run dev` / `npm run build` / `npm run preview` / `npm run setup`
(`scripts/setup.mjs`, first-time interactive setup). `node db/seed.mjs`
seeds an initial admin against whichever backend is active.

## 3. Data model (source of truth: `db/schema.sql`)

- **`users`** — `id, username, password_hash, display_name, role (staff|manager|admin), email, phone, disabled, tier_id`. `tier_id` and everything about tiers is **admin-only visible** — never surfaced to the assigned staff member or to a manager (see `state.js`).
- **`tiers`** — admin-defined monthly caps: `max_shifts_per_month, max_weekend_shifts_per_month, max_days_off_per_month, max_weekend_days_off_per_month`. Any column may be `NULL` = no cap on that dimension. Enforced by `src/lib/tierLimits.js`, which **hard-denies** (unlike coverage warnings below) but never names the tier in the denial message shown to staff.
- **`shifts`** — the actual, scheduled truth. `id, user_id, date (YYYY-MM-DD), start_time, end_time (HH:MM 24h), department (FOH|BOH|null), notes, import_id`. `date` is always the day the shift **starts**; `end_time <= start_time` means it crosses midnight (e.g. `16:30`–`02:30`).
- **`shift_templates`** — recurring weekly coverage blocks (e.g. "Opener, 9am–3pm, Mon–Fri") an admin defines once. `days_of_week` is a comma-separated string of `0`(Sun)`-6`(Sat), e.g. `"1,2,3,4,5"`. `min_staff`/`max_staff` are both optional; `min_staff` drives a non-blocking staffing warning when removing someone would drop a covered shift below it (`src/lib/coverage.js`), `max_staff` drives the Schedule Builder's conflict flag when combined pending+approved shifts on that window exceed it (`src/lib/client/coverage.js`). **Matching a shift/request against a template is containment-based** (`start >= template.start && end <= template.end`), never any-overlap — a real bug this session was a shift merely touching part of a template's hours getting wrongly counted against its capacity.
- **`shift_requests`** — staff-submitted **availability**, not a "request" in the UI sense any more (see §4). `id, user_id, action (create|update|delete), shift_id (null for create), date, start_time, end_time, department, notes, status (pending|approved|denied), denial_reason, staffing_warning`. `action='create'` with `start_time='00:00', end_time='23:59'` is the **"available all day"** sentinel — display it as "All day", not the literal times (see `timeLabel()` in both `schedule.astro` and `admin/schedule.astro`).
- **`time_off_requests`** — `id, user_id, start_date, end_date, reason, status, denial_reason, staffing_warning`.
- **`swap_posts`** / **`swap_claims`** — a staff member posts an existing shift for swap; another claims it (optionally offering one of their own shifts back); admin/the poster resolves it.
- **`shift_imports`** — one row per bulk import batch (`uploaded_by, filename, row_count`); shifts created by that batch are tagged with its id via `shifts.import_id` so "remove upload" can undo just those rows. Caps and swap posts created by an import are **not** batch-undoable.
- **`day_caps`** — a one-off exception on a single date/window (`date, window_start, window_end, max_shifts, note`), separate from the recurring `shift_templates`.
- **`api_keys`** — programmatic access for an external agent (see §5). `label, key_prefix, key_hash, created_by, last_used_at, revoked`. The raw key is shown exactly once at creation.
- **`password_reset_requests`** — there's no email sender; "Forgot password?" files a row here for an admin to see and resolve manually.

## 4. Business rules already built (don't rebuild or contradict these)

- **Staff submit availability, not shift requests.** The staff-facing `schedule.astro` card is "My Availability" — days/times they're available, including "available all day". There is **no approve/deny control anywhere in the staff UI**; staff only ever see a status badge and a Cancel button on their own pending items.
- **Only the Schedule Builder (`admin/schedule.astro`) approves/denies/schedules.** Admin/manager see pending availability + pending time off + already-approved shifts all on one calendar (Month/Week/Day views), and can: right-click a pending item to approve/deny, right-click an approved shift to remove it from the schedule, and **drag anything — pending or already scheduled — onto another day to move it**. Dragging a pending request PATCHes `/api/shift-requests/:id`; dragging an approved shift PATCHes `/api/shifts/:id`. This whole page is gated admin/manager-only by `middleware.js`.
- **Conflict flagging covers both pending and approved.** `computeShiftRequestConflicts` (client) and the server-side coverage checks both treat a template's `max_staff`/`min_staff` against the combined set of approved shifts + pending requests for that date+window — not pending-only.
- **Tier limits hard-deny; coverage checks only warn.** A tier's monthly cap (`tierLimits.js`) blocks a create outright with a denial reason. A `min_staff` coverage check (`coverage.js`) only attaches a `staffing_warning` string — the request still goes to Pending for a human to decide with full context.
- **Time off within 7 days shows a non-blocking warning** ("may not be approved in time due to staffing constraints") on the request form — it does not block submission; it still goes through the normal admin approve/deny flow. (Added because staff sometimes request time off for personal appointments last-minute; the owner wants them warned, not blocked.)
- **Visual conventions on the Schedule Builder calendar**: white/outlined = pending, green = scheduled (approved), red = conflict (overrides the pending/scheduled color), blue = time off.

## 5. Bulk data ingestion — the "extension of the app" path

**This already exists and is the intended mechanism for an agent to load or
change schedule data in bulk — build on it, don't reinvent it.** It was
explicitly designed for this: `src/lib/shiftImport.js`'s header comment
gives the example *"one spoken request to an AI assistant ('add Jorge
Tuesday 11-7, cap Friday lunch at 2 people, and put my Saturday shift up
for swap') can span all three [row types]"*, and the API key creation
endpoint literally suggests **"Hermes"** as an example key label.

### How an agent should use it, end to end

1. **Get an API key** (once, then reuse it): an admin creates one via the
   Manage UI, or `POST /api/admin/shift-imports` needs an admin session —
   but key creation itself is `POST /api/admin/api-keys` with `{ "label":
   "Hermes" }` (also admin-session-gated). The raw key
   (`shwrm_<32 chars>`) is returned **once**, in the response body — save
   it; only its hash is kept server-side after that.
2. **Resolve the current roster** so names in freeform input map to real
   users: `GET /api/admin/shift-import-template` returns a CSV whose
   comment header lists every active `username -> Display Name` pair — use
   it (or `GET /api/state`'s `users` array, if you have a session instead
   of an API key) to know exactly who's who before building rows.
3. **Convert whatever the human handed you** (a photo of a handwritten
   schedule, a pasted spreadsheet, a Telegram message, a messy CSV) into
   rows matching the shape below — this conversion is the agent's job; the
   endpoint only accepts the canonical shape.
4. **POST to `/api/public/shift-imports`**:
   ```
   Authorization: Bearer shwrm_xxxxxxxxxxxxxxxxxxxxxxxx
   Content-Type: application/json
   { "filename": "optional label for this batch", "rows": [ { ... }, ... ] }
   ```
   (or `Content-Type: text/csv` with the raw CSV as the body — same row
   shape, comment lines starting with `#` are ignored).
5. **Handle the response.** It's all-or-nothing: if ANY row fails
   validation, nothing is written and you get back
   `{ error, rowErrors: [...] }` (up to 50, each `"Row N: <reason>"`) —
   fix and resubmit the whole batch, don't try to patch just the bad rows
   in isolation. On success: `{ ok: true, import, count, breakdown: {
   shifts, caps, swaps } }`.

### Row shape (`type` column picks the kind; all three can be mixed in one batch)

| `type` | Fields | Notes |
|---|---|---|
| `shift` | `username, date, start_time, end_time, notes` | Creates an actual scheduled shift directly (not a pending request) |
| `cap` | `date, window_start, window_end, max_shifts, notes` | One-off exception on a single date (upserted — re-importing the same date+window updates it) |
| `swap` | `username, date, start_time, notes` | `notes` = swap reason. Matches an **existing** shift for that user/date/start_time and posts it for swap — errors if no such shift exists |

- **Name matching is fuzzy on purpose**: `username` accepts the exact
  system username (always exact/unique), OR a display name, OR a first
  name — because a human is far more likely to say "Ray" than the login
  username `ray`. If a first name matches more than one person, that name
  is poisoned to "ambiguous" and the row errors asking for the full name
  or username instead of guessing.
- Dates must be `YYYY-MM-DD`, times `HH:MM` (24h). `start_time >= end_time`
  on a `shift` row is valid and means it crosses midnight — don't
  "correct" it.
- Max 1000 rows per batch.
- Everything in one import (a batch of `shift` rows) is tagged with the
  same `import_id`, so it can be identified/undone as a unit later via
  `shift_imports`.

**When the user asks you to "load in this week's schedule" or similar**:
that's this pipeline. Don't build a one-off script or hand-write SQL — call
this endpoint (or, if you're editing this app's own code rather than
calling it externally, use `runShiftImport()` from `src/lib/shiftImport.js`
directly, which is exactly what both the admin-UI and API-key routes call).

## 6. Reading live state, and API-key auth app-wide

`GET /api/state` is the single aggregate read every page polls after a
mutation. Shape depends on role:
- Everyone: `me, users (public fields only), shifts, swapPosts, swapClaims, dayCaps, shiftRequests, timeOffApproved (everyone's, minimal fields), timeOffMine`.
- Staff-or-above additionally: `timeOffAll, shiftImports, apiKeys (metadata only, never the raw key), passwordResetRequests, shiftTemplates`.
- Admin additionally: `tiers, userTiers`.

**An API key works on every `/api/*` route, not just bulk-import** —
`middleware.js`'s `resolveApiKeyUser()` resolves an `Authorization: Bearer
shwrm_xxxxx` header into the real user who created the key (their exact
`id`/`username`/`role`/`display_name`), the same way a session cookie does,
whenever no cookie is present. This means `GET /api/state`,
`POST /api/shifts`, `PATCH /api/shift-requests/:id`, every route — works
for an API-key caller with zero per-route changes, and a write is
attributed to a real person exactly as if they'd clicked it in the browser.
`/api/public/shift-imports` predates this and still does its own inline
auth check; it wasn't touched or migrated, it just now has company. See "If
you're being asked to integrate with this app as an agent" at the very top
of this file, and `AGENT-TRAINING.md`, for the full, generated catalog of
what an agent can call and which actions are human-only by design.

## 7. Known gotchas (hit once already — don't rediscover these)

- **Astro-scoped `<style>` blocks never apply to `innerHTML`-built content.** A page's scoping attribute only lands on elements present at Astro *build* time; anything a client `<script>` builds via `innerHTML` (the Schedule Builder's whole calendar grid, for one) silently never matches a scoped style. Any CSS for script-generated markup must live in the global, unscoped `src/styles/global.css`.
- **A CSS comment whose own text contains a literal `*/` truncates the rest of the stylesheet.** e.g. writing `.card/.btn-*/.modal` inside a `/* ... */` comment closes it early at the `*/` that `.btn-*` + `/` accidentally forms — everything after it silently disappears from the parsed stylesheet even though the raw file text looks fine. **After every edit to `global.css`, verify comment balance**: `(css.match(/\/\*/g)||[]).length === (css.match(/\*\//g)||[]).length`.
- **`local.js`'s DB update functions must merge field-by-field, never `Object.assign(row, updates)` directly.** A caller sending a partial update (e.g. the calendar's drag-to-move sending only `{ date }`) still has every *other* key present on the `updates` object with value `undefined` (from the API route's own object-literal shape) — a blind `Object.assign` copies those `undefined`s over the existing values, wiping them. Always do `if (updates.field !== undefined) row.field = updates.field;` per field (mirror whatever `neon.js` does for the same table).
- **`neon.js`'s raw SQL `UPDATE` must explicitly `SET` every column meant to survive**, falling back to the existing row's value (`updates.x ?? row.x`) for anything not being changed. A column simply left out of the `UPDATE ... SET` text is never touched in Postgres, so it's easy to add a new partial-update caller against a `neon.js` function that was only ever written to update two of a row's five columns and have it silently no-op the rest — this actually shipped once (the calendar's pending-request drag-to-reschedule updated `status`/`denial_reason` fine locally against `local.js`'s Object.assign, but `neon.js`'s `updateShiftRequest` had no `date`/`start_time`/`end_time` in its `UPDATE` at all, so the same drag silently did nothing on the real production database).
- **Shift-to-template matching is containment, not overlap** (see §3) — this was a real, shipped bug once (an unrelated shift touching part of a template's window counted against its capacity).
- **`db.getUserById(me.id)` can return `null` for a session that predates a reseed** (local dev only, but the same class of bug could occur in prod against a deleted user) — `checkShiftCreateLimit` in `tierLimits.js` doesn't guard against this and throws a 500 instead of a clean re-auth prompt. Known, not yet fixed (see any open task for "Fix 500 on stale-session shift request"). **This bug is contagious**: an API key's `created_by` is set from `context.locals.user.id` at the moment it's created (`POST /api/admin/api-keys`) — a key created from a stale session inherits that same nonexistent user id, and `resolveApiKeyUser()` in `middleware.js` will then correctly-but-confusingly reject every call made with that key as 401 (it fails closed, it doesn't crash — but the symptom looks like "the key doesn't work" rather than "the session that created it was already broken"). If a freshly-created key immediately 401s on every call, check this before assuming the new middleware code is at fault: log out and log back in properly, then create the key again.

## 8. Verification checklist before calling a change done

1. `npm run build` — catches Astro/type errors immediately.
2. If you touched `src/styles/global.css`: check comment balance (§7).
3. If you touched anything in `src/lib/db/*`: sanity-check the change makes sense against **both** `local.js` and `neon.js` — a partial-update bug in one backend and not the other is exactly how both bugs in §7 shipped.
4. For a UI change: run the dev server, actually click/drag/right-click the feature, check the browser console for errors — don't rely on a clean build alone.
5. For a bulk-import change: hit the endpoint with a real payload (a handful of `shift`/`cap`/`swap` rows) and check `/api/state` reflects it, plus at least one deliberately-bad row to confirm the all-or-nothing validation still rejects cleanly.
