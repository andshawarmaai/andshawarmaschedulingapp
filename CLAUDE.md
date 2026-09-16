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
- **Only the Schedule Builder (`admin/schedule.astro`) approves/denies/schedules — including undoing an already-approved time-off block.** Admin/manager see pending availability + pending AND approved time off + already-approved shifts all on one calendar (Month/Week/Day views), and can: right-click a pending item to approve/deny, right-click an approved shift or approved time-off (solid indigo, vs. pending time-off's lighter tint) to remove it from the schedule, and **drag a shift or a pending request — but not time off, which spans a date range — onto another day to move it**. Dragging a pending request PATCHes `/api/shift-requests/:id`; dragging an approved shift PATCHes `/api/shifts/:id`; removing approved time off is `DELETE /api/timeoff/:id` (no status restriction on that endpoint — it was always capable of this, the calendar just didn't surface approved time off at all before this was added). The plain staff schedule page (`schedule.astro`) is deliberately read-only for time off — an admin who wants to undo an approved one comes here, on purpose, so there's one editing surface, not two. This whole page is gated admin/manager-only by `middleware.js`.
- **Adding a shift directly (not waiting on someone's submitted availability) also only happens here.** A "+" appears on hover over a Month cell or a Week day header (hidden the rest of the time so a full month grid doesn't look cluttered with 35+ buttons); Day view has the same thing as an always-visible "+ Add shift" button instead, since only one date is ever on screen there. Either opens the same small modal (staff picker, date, start/end time, notes) used for both add and edit — `POST /api/shifts` when adding.
- **Clicking an already-scheduled (green) shift chip/bar opens that same modal in edit mode** (prefilled, `PATCH /api/shifts/:id` on save, plus a Delete button as an alternative to the right-click menu) — for changing the time, assigned staff, or notes without re-creating it. Dragging still does a quick date-only move; a completed native HTML5 drag never also fires the element's `click` (the browser suppresses it), so the two coexist without fighting each other.
- **The Schedule Builder's usage instructions live in a "❓ How to use this" popup**, not a permanent paragraph on the page — a plain bulleted `<ul>` in a modal, same content as before just out of the way until asked for.
- **Both `schedule.astro` (staff) and `admin/schedule.astro` have a "🖨️ Print / Save as PDF" button** — plain `window.print()` plus a `@media print` stylesheet (`.no-print` hides controls/nav/modals, `.print-only` reveals a plain shift-list table invisible on screen). No PDF library: every major browser's print dialog already offers "Save as PDF" as a destination, so this covers both "print" and "export a PDF" from one button with zero new dependencies.
- **The Schedule Builder also has an "⬇️ Export to spreadsheet" button** — downloads a CSV of the durable schedule data (`shifts`, `dayCaps`, `shiftTemplates`; deliberately *not* pending requests/time-off/swaps, which are in-flight workflow state, not durable structure) in exactly the row shape `/api/public/shift-imports` and `/api/admin/shift-imports` accept, so it doubles as a backup — the same file can be re-imported later. Verified round-trip: export → `parseCsv` → `validateImportRows` reproduces the original data exactly, including a note field containing both a comma and embedded quotes.
- **Conflict flagging covers both pending and approved.** `computeShiftRequestConflicts` (client) and the server-side coverage checks both treat a template's `max_staff`/`min_staff` against the combined set of approved shifts + pending requests for that date+window — not pending-only.
- **Tier limits hard-deny; coverage checks only warn.** A tier's monthly cap (`tierLimits.js`) blocks a create outright with a denial reason. A `min_staff` coverage check (`coverage.js`) only attaches a `staffing_warning` string — the request still goes to Pending for a human to decide with full context.
- **Time off within 7 days shows a non-blocking warning** ("may not be approved in time due to staffing constraints") on the request form — it does not block submission; it still goes through the normal admin approve/deny flow. (Added because staff sometimes request time off for personal appointments last-minute; the owner wants them warned, not blocked.)
- **Visual conventions on the Schedule Builder calendar**: white/outlined = pending, green = scheduled (approved), red = conflict (overrides the pending/scheduled color), blue = time off.
- **Dragging a shift or pending request to a new date now asks for confirmation first** ("Move {name}'s shift/pending request to {date}?", a plain `confirm()`, matching the existing delete/approve confirmation style) — a single accidental drag used to silently move someone with no way to tell it happened.
- **An "Undo" button sits right above the calendar** (also Cmd/Ctrl+Z, ignored while typing in a field) and can roll back any number of steps this session, most-recent-first: moving, adding, editing, or deleting a shift. Each action pushes its own exact-reverse call onto an in-memory stack (`pushUndo`/`undoLast` in `admin/schedule.astro`) — cleared on page reload, no server-side history. **Deliberately does not cover approve/deny or time off** — those are one-way decisions with their own confirmation already (deny prompts for a reason), and reversing an approval would mean untangling the `shifts` row it created too; out of scope for now.
- **Hovering a red conflict flag shows a real popup explaining why, in plain English** (`showConflictTooltip`/`.conflict-tooltip` in `admin/schedule.astro`/`global.css`) — not the browser's own slow, easy-to-miss `title` tooltip. Flagged chips/bars carry the note in `data-conflict-note` instead of `title` for this reason; non-flagged items (the plain "click to edit, drag to move" hint) still just use `title`, since that one's minor and not urgent.
- **Day view has a "coverage" panel above the timeline**: one card per shift template that applies to that date, colored red if under its `min_staff`, green ("Fully staffed") if it meets/exceeds it, amber if it exceeds `max_staff`, or neutral if the template has no min set — plus a row of draggable staff-name chips underneath. The big number reads as "X of Y" (against `min_staff`, or `max_staff` once over it) rather than a bare count, since a bare "0" means nothing without also reading the min/max line above it. Dragging a name onto a card creates a shift for that exact template's date/start/end (`POST /api/shifts`); clicking a card (no drag) opens the same Add Shift modal instead, prefilled with that block's time, for admins who'd rather not drag. Point being: an admin shouldn't have to mentally cross-reference a pile of individual chips against the Shift Templates list to tell whether a day is actually fully staffed — every card should read green, like finishing a puzzle. Computed by `computeDayCoverage()` in `client/coverage.js`, using the exact same best-fit template attribution as the conflict flags above, so the two always agree.
- **Coverage checking is instant-by-instant, not a single daily total.** `computeDayCoverage`/`computeTemplateTimeGaps` (`client/coverage.js`) sweep a template's window and split it into sub-intervals wherever the concurrent headcount changes (`sweepTemplateCoverage`) — deliberately ANY-OVERLAP matching, not the strict best-fit containment `computeShiftRequestConflicts` uses (that one's answering "which named role is this shift," this one's answering "is this window covered right now"). A shift that starts an hour early or ends an hour late still provides real coverage during the part that overlaps, and a shift that's simply time-shifted must not read as a wide-open slot. The coverage panel's "X of Y" reports the WORST moment in the window when there's a `min_staff` (so "fully staffed 9-5 but empty the last hour" correctly shows as short), and the PEAK moment for `over`/`neutral`.
- **The Day view timeline itself also shows open slots, not just the summary cards above it**: each actual gap SEGMENT (not the whole template) contributes one dashed red "{name} — open slot" block per still-needed head, positioned at its own precise time-of-day and packed into the SAME overlap-column layout as real shift bars (`computeGhostItems`/`coverageGapBarHtml`/`dayBarsHtml` in `admin/schedule.astro`) — never a background band that real bars could fully cover. Each open slot is its own drag target/click target exactly like a coverage-panel card. Week view deliberately doesn't get these (`dayBarsHtml`'s `ghostItems` param is Day-view-only) — the narrower week columns would get too cluttered.
- **A gap segment landing entirely past midnight must be filled with a shift dated the NEXT calendar day, not the day being viewed** — a segment whose raw minutes are ≥1440 converts to an ordinary-looking HH:MM range (e.g. "01:30-02:30") that, dated `iso`, would silently record as early THIS morning instead of the actual overnight tail (`computeGhostItems`'s day-bump, `addDays` in `admin/schedule.astro`). Correspondingly, when sweeping a date's coverage, a shift dated the FOLLOWING day that starts very early is folded back in shifted +24h (`rowsForSweep` in `client/coverage.js`) — otherwise a shift created specifically to fill that overnight tail would be invisible to that date's own coverage check and the red block would never clear. Both sides of this same fix shipped together; a change to one without the other will reintroduce either a wrong-date bug or a gap that can't be filled.
- **The Add/Edit Shift modal has "quick fill" buttons for whichever shift templates apply to the selected date** (`renderTemplatePicker` in `admin/schedule.astro`) — one pill per matching template (filtered by day-of-week, re-filtered whenever the Date field changes), which sets Start/End to that template's exact times on click. Start/End stay freely editable below it for a genuinely custom shift; this is purely a shortcut, not a constraint.
- **Filling a coverage block/open slot has two independent paths**: drag a roster name onto it (native HTML5 drag-and-drop, not reliable on every trackpad/browser), or click a name to arm it (`.roster-chip.selected`) then click a block — this opens the normal Add Shift modal with that person and the block's exact date/time pre-filled rather than saving instantly, so there's always a review step. `selectedRosterUserId` in `admin/schedule.astro` tracks the armed name; it's cleared on every render and after each use.
- **A denied availability entry must be explicitly acknowledged by the staff member before it disappears** — a "✓ Got it" button next to it on `schedule.astro`'s "My Availability" list `DELETE`s the `shift_requests` row (same endpoint pending's Cancel button already used; the old `if (req.status !== 'pending') return 409` restriction on that DELETE was removed so this works, matching `/api/timeoff/[id].js`'s DELETE, which never had that restriction). No auto-expiry by time or by login count — the owner explicitly wants a deliberate click, not something that just silently ages out, so a denied row is never actually gone until the person has actually seen and dismissed it.

## 5. Bulk data ingestion — the "extension of the app" path

**This already exists and is the intended mechanism for an agent to load or
change schedule data in bulk — build on it, don't reinvent it.** It was
explicitly designed for this: `src/lib/shiftImport.js`'s header comment
gives the example *"one spoken request to an AI assistant ('add Jorge
Tuesday 11-7, cap Friday lunch at 2 people, put my Saturday shift up for
swap, and set up a recurring 9-6 opener template') can span all four [row
types]"*, and the API key creation endpoint literally suggests **"Hermes"**
as an example key label. Proven end-to-end 2026-09-15: a real restaurant's
"schedule formula" (six recurring shift templates) was ingested this way
via `type=template` rows over a real API key — see the `template` row in
the table below.

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
3. **Convert whatever the human handed you** — an actual `.xlsx`/`.csv`
   spreadsheet file, a Google Sheets export, a photo of a handwritten
   schedule, a pasted Telegram message, a messy CSV — into rows matching
   the shape below. **Do this yourself; don't ask the human to reformat
   it or hand back a description of what the file contains.** Read the
   file directly (an `.xlsx` can be opened and read like any other file),
   build the canonical rows, and POST them — that conversion is the whole
   point of routing this through an agent instead of a rigid upload form.
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

### Row shape (`type` column picks the kind; all four can be mixed in one batch)

| `type` | Fields | Notes |
|---|---|---|
| `shift` | `username, date, start_time, end_time, notes` | Creates an actual scheduled shift directly (not a pending request) |
| `cap` | `date, window_start, window_end, max_shifts, notes` | One-off exception on a single date (upserted — re-importing the same date+window updates it) |
| `swap` | `username, date, start_time, notes` | `notes` = swap reason. Matches an **existing** shift for that user/date/start_time and posts it for swap — errors if no such shift exists |
| `template` | `name, days_of_week, start_time, end_time, min_staff, max_staff` | Creates or updates a recurring `shift_templates` row. `days_of_week` is `0`(Sun)`-6`(Sat), separated by comma, space, or `\|` (e.g. `"1 2 3 4 5"` — no CSV quoting needed). **Upserted by exact `name`** — importing the same name again updates that template in place rather than duplicating it; response includes `templatesCreated`/`templatesUpdated` counts. Validation (`parseDaysOfWeek`/`parseStaffCount`) lives in `src/lib/shiftTemplateFields.js`, shared with the admin API routes so a bulk import is held to the exact same rules as one entered through the Manage UI. |

- **`username` matching (on `shift`/`swap` rows) is fuzzy on purpose**:
  accepts the exact system username (always exact/unique), OR a display
  name, OR a first name — because a human is far more likely to say "Ray"
  than the login username `ray`. If a first name matches more than one
  person, that name is poisoned to "ambiguous" and the row errors asking
  for the full name or username instead of guessing. **This is unrelated
  to a `template` row's `name` field**, which is matched exactly
  (case-insensitively) against existing templates for the upsert decision —
  there's no fuzzy/ambiguous handling there since a template name isn't
  drawn from a fixed roster the way a person's name is.
- Dates must be `YYYY-MM-DD`, times `HH:MM` (24h). `start_time >= end_time`
  on a `shift` or `template` row is valid and means it crosses midnight —
  don't "correct" it.
- Max 1000 rows per batch.
- Everything in one import (a batch of `shift` rows) is tagged with the
  same `import_id`, so it can be identified/undone as a unit later via
  `shift_imports`. `cap` and `template` rows are upserted directly and are
  **not** part of that undo — there's no clean "prior state" to revert a
  cap or a template edit to.

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
- **Shift-to-template matching is containment, not overlap, AND every shift is attributed to only its single *best-fit* (narrowest containing) template — never every template it happens to fit inside.** Both `src/lib/coverage.js` (server, `min_staff` removal warnings) and `src/lib/client/coverage.js` (client, `max_staff` conflict flags + the Day view coverage panel) implement this the same way: `bestFitTemplate()` picks the smallest-duration template among all that contain the shift. This was a real, shipped bug twice over: first, an unrelated shift merely touching part of a template's window counted against its capacity (fixed by requiring full containment); then — 2026-09-16 — a restaurant's real, intentional nested templates ("1 Opener, 9am–9:30pm" containing "3 Mid AM, 9am–6pm") caused every Mid AM shift to *also* count against the Opener's 1-person cap, since a shift fitting inside the narrow Mid AM window technically also fits inside the wider Opener window too. Containment alone was never enough — a shift must be attributed to exactly one template, its tightest match, or nested/overlapping templates (a completely normal restaurant staffing pattern) produce false conflicts.
- **`db.getUserById(me.id)` can return `null` for a session that predates a reseed** (local dev only, but the same class of bug could occur in prod against a deleted user) — `checkShiftCreateLimit` in `tierLimits.js` doesn't guard against this and throws a 500 instead of a clean re-auth prompt. Known, not yet fixed (see any open task for "Fix 500 on stale-session shift request"). **This bug is contagious**: an API key's `created_by` is set from `context.locals.user.id` at the moment it's created (`POST /api/admin/api-keys`) — a key created from a stale session inherits that same nonexistent user id, and `resolveApiKeyUser()` in `middleware.js` will then correctly-but-confusingly reject every call made with that key as 401 (it fails closed, it doesn't crash — but the symptom looks like "the key doesn't work" rather than "the session that created it was already broken"). If a freshly-created key immediately 401s on every call, check this before assuming the new middleware code is at fault: log out and log back in properly, then create the key again.

## 8. Internationalization (English/Spanish)

The staff-facing app (Home, Schedule, Swap, Time Off, Login) has a plain
EN/ES toggle — **not** the admin/Manage side, which stays English-only on
purpose. It's a simple cookie (`shawarma_lang`, see `src/lib/i18n.js`), not
a per-user account setting: the owner explicitly wanted "anybody" using a
device to be able to flip it, including before logging in (the login page
itself renders in the chosen language).

- `src/lib/i18n.js` is the single dictionary (`en`/`es`) and `t(lang, key, vars)` helper — isomorphic, imported both from Astro frontmatter (`getLang(Astro)` reads the cookie) and from page `<script>` modules (each page sets `window.__lang` via a tiny `define:vars` script, then imports `t` directly from `i18n.js`).
- `src/components/LangToggle.astro` is the switch itself (sets the cookie, reloads) — rendered standalone on `login.astro`, and inside the shared sidebar's footer via `Layout.astro` (see §9) **only when `active` isn't `manage`/`schedule-builder`** (`showLangToggle` in `Layout.astro`) — the sidebar itself is now shared with admin/manager, but the toggle staying staff-only was an explicit, separate decision that the shared sidebar must not accidentally undo.
- `formatDate()` in `src/lib/client/format.js` takes an optional `{ lang }` to localize month/weekday names via `toLocaleDateString` (e.g. "septiembre" not "September") — pass it through on every call from a translated page; it defaults to English for admin-side callers that don't pass it.
- **Known, accepted gap**: error messages that come from the *server* (e.g. a failed login's "Incorrect username or password...", or any API route's `error` field) stay in English regardless of the toggle — only client-side/static UI text is translated. Translating server error strings would mean threading `lang` through every API route; out of scope for a "flip of a switch" feature.
- **Adding a new staff-facing string**: add the key to both `en` and `es` in `i18n.js`, then use `t(lang, 'your.key')` in the `.astro` markup (frontmatter must call `getLang(Astro)` first) and/or in that page's client `<script>` (must import `t` and read `window.__lang`, set by that page's own `define:vars` block — copy the pattern from any of the four pages above, they're all identical).

## 9. One shared layout — `src/layouts/Layout.astro`

Every page (staff and admin/manager alike) renders through this single
layout — there is no more separate mobile-first "app" shell and desktop
"admin" shell. This was a deliberate replacement of two earlier layouts
(`AppLayout.astro`, `AdminLayout.astro`, both deleted) per the owner's
explicit complaint that the staff Schedule and the admin Schedule Builder
"felt like two different pages" instead of one continuous app.

- **One nav list, role-gated by content not by layout.** `Layout.astro` always renders Home/Schedule/Swap/Time Off; it appends Manage + Schedule Builder (behind a `<div class="sidebar-divider">`) only when `user.role` is `admin`/`manager`. `middleware.js` still gates the actual routes regardless — this is only about which links show.
- **`active` prop values**: `home`, `schedule`, `swap`, `timeoff`, `manage`, `schedule-builder`. The staff Schedule page (`schedule.astro`) uses `active="schedule"`; the admin Schedule Builder (`admin/schedule.astro`) uses `active="schedule-builder"` — **not** `"schedule"` — specifically so the two don't collide in one shared nav list (they used to be two different sidebars, so this never mattered before).
- **Desktop**: the sidebar is always visible and toggles between full-width and an icon-only rail via `.sidebar-collapse-btn`, persisted in `localStorage` (`shawarma_sidebar_collapsed`) so it survives reloads/navigation.
- **Mobile (≤860px)**: the sidebar becomes an off-canvas drawer instead (the owner's explicit choice over a permanent icon rail) — hidden by default, opened via a hamburger (`.sidebar-toggle-btn`) in the topbar, closed by tapping `.sidebar-backdrop` or by clicking any nav link. Both behaviors' CSS lives in `global.css` under `.app-shell`/`.app-sidebar`/etc.; the `sidebar-collapsed` and `sidebar-open` classes are mutually exclusive in practice (collapse is desktop-only, drawer is mobile-only) but the CSS handles both being present without breaking.
- **The EN/ES toggle is intentionally excluded from admin-only pages** even though it's in the now-shared sidebar footer — see §8.
- Client-JS-built markup (e.g. the Schedule Builder's calendar, built via `innerHTML`) still can't use the `<Icon>` Astro component — inline raw SVG string constants instead (see `CHECK_SVG`/`ALERT_SVG` in `schedule.astro`/`admin/schedule.astro` for the pattern).
- **The staff Schedule calendar (`.calendar-grid`/`.calendar-day` in `global.css`) intentionally mirrors the Schedule Builder's own month-grid styling** (sticky header, bordered cells, red-circle today badge, `min-width: 45.5rem` so tiles have real room for a name + time before scrolling) — the owner explicitly wanted the two calendars to look like the same product, not a plainer staff version next to a nicer admin one. `main.app-page` is shared at `max-width: 90rem` for the same reason; keep any future calendar tweak applied to both, or they'll visibly drift apart again.

## 9. Verification checklist before calling a change done

1. `npm run build` — catches Astro/type errors immediately.
2. If you touched `src/styles/global.css`: check comment balance (§7).
3. If you touched anything in `src/lib/db/*`: sanity-check the change makes sense against **both** `local.js` and `neon.js` — a partial-update bug in one backend and not the other is exactly how both bugs in §7 shipped.
4. For a UI change: run the dev server, actually click/drag/right-click the feature, check the browser console for errors — don't rely on a clean build alone.
5. For a bulk-import change: hit the endpoint with a real payload (a handful of `shift`/`cap`/`swap` rows) and check `/api/state` reflects it, plus at least one deliberately-bad row to confirm the all-or-nothing validation still rejects cleanly.
