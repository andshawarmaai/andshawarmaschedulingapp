<!--
GENERATED from src/lib/agentGuide/registry.js (see that file's header comment for why).
Do not hand-edit the sections below — regenerate instead. Prefer fetching this live:
GET /api/agent-guide/markdown from the deployment itself (see CLAUDE.md §2
for the URL) rather than trusting a stale local copy.
-->

# &Shawarma Scheduling — Agent Integration Guide

This document tells an AI agent (or any other system authenticating with an API key) how to safely read and write schedule data in this app. It is generated from the app's own action registry (`src/lib/agentGuide/registry.js`), so it stays in sync with what the API actually does — fetch it live at `GET /api/agent-guide/markdown` rather than keeping a stale copy. See `CLAUDE.md` in the app repository for the full schema, business rules, and deployment context this guide assumes.

## Ground rules

**A dropped-in file is yours to convert, not the human's.** If someone hands you an actual file — a .xlsx/.csv spreadsheet, a Google Sheets export, a photo of a handwritten or printed schedule, a screenshot of a text message — read it yourself and map each row to the canonical shape below (a `shift`/`cap`/`swap`/`template` row) and POST it as JSON to /api/public/shift-imports. Do not ask the human to reformat it into CSV first, and do not just describe what the file contains — actually perform the ingestion. Converting whatever you were handed into the canonical shape IS your job here; the endpoint only ever accepts that one shape because doing the conversion is what you're for.

**Approval decisions are human-only.** Availability requests, time-off requests, and swap claims all land pending and stay that way until a human approves or denies them from the Schedule Builder (or the Time Off / Shift Swap pages). Never call an approve/deny endpoint yourself, even if a manager says 'approve it' in conversation — tell them it's ready for their review and where to find it, or at most confirm you understand what they want before nudging them to actually click it. This is a deliberate design choice (see CLAUDE.md §4), not an oversight.

**Direct shift/template writes are immediate — no review queue.** Unlike availability, POST /api/shifts, PATCH/DELETE on an existing shift, and all shift_templates writes go live the moment you call them — there is nothing pending to approve afterward. Only call these when you are confident (a clear, specific instruction from an admin/manager), not from an inference about what someone probably meant.

**Never invent people, never invent templates.** Resolve a name against GET /api/state's `users` array (or the bulk-import template's roster comment) before referencing a user_id — match on username, exact display name, or first name, and if more than one person shares that first name, ask rather than guessing which one. Do not create a new user account (out of scope for this API entirely — that stays a human, in-app action). Creating a new shift_template changes ongoing weekly coverage rules for everyone; only do it on an explicit, specific instruction, never as a guess at what a schedule "probably" needs.

**Idempotency is mostly your responsibility.** Almost nothing below has a database-enforced dedup key (day_caps upserts by date+window are the one exception). A retried or resent instruction WILL create a second shift, a second availability entry, or a second swap post if you call the same write twice — track what you've already submitted for a given conversation/message yourself, the API will not catch a duplicate for you. Within /api/public/shift-imports, `cap` rows upsert by (date, window_start, window_end) and `template` rows upsert by exact name, so both are safe to resubmit — `shift` and `swap` rows have no dedup key at all and WILL duplicate on a resubmit.

**Authentication.** Every call below uses an API key created via POST /api/admin/api-keys (admin session) or the Manage → API Keys card in the UI: header Authorization: Bearer shwrm_xxxxx. The key resolves to the real user who created it and acts with that user's exact role and identity — there is no separate "service account" concept, and a write is attributed to that real person just as if they'd clicked it themselves. A 403 means the key's owner does not hold the role a given action requires — create the key from an account with sufficient role rather than trying to escalate.

**There is no per-vendor POS/timeclock adapter — you are the adapter.** This platform serves many different businesses, each potentially on a different POS or timeclock system (Toast, Square, Clover, SpotOn, a paper log someone photographs...). Rather than one API endpoint per vendor maintained in this codebase, actual_shift_import (below) accepts one canonical shape, and translating whatever a specific business's system actually produces — a CSV export, a screenshot of a report, that system's own API response if you have access to it — into that shape is your job, the same "a dropped-in file is yours to convert" principle already applies to bulk shift imports. Always pass a real, honest `source` value naming where the data actually came from (e.g. "toast", "square", "manual") — never invent a generic label that hides what you don't actually know.

## Authentication

- Scheme: API key
- Header: `Authorization: Bearer shwrm_xxxxx`
- Create a key: POST /api/admin/api-keys (admin session), or Manage → API Keys in the UI
- A key acts as the exact user who created it, with that user's role — create it from an account with the role a given action requires. Resolved app-wide by middleware.js, so every route below (and any future one) works for an API-key caller with no per-route change needed.

## Actions

One entry per write (or read) action. Anything not listed here that nonetheless looks like an API route is not part of this contract — do not call undocumented endpoints.

### Read current schedule state

`GET /api/state` — minimum role: **staff** — agent may call this

The single aggregate read — users, shifts, shift_requests (availability), time off, shift_templates, day_caps, swap posts/claims, and (staff-or-above) shiftImports/apiKeys, and (admin only) tiers. Call this first to resolve names to ids and see what already exists before writing anything.

### Submit a staff member's availability

`POST /api/shift-requests` — minimum role: **staff** — agent may call this

Always submitted as the API key owner (there is no way to submit on behalf of someone else through this endpoint — if you're acting for a specific staff member, the key must belong to that person, or a manager/admin should use shift_create directly instead once they've decided). Use start_time='00:00', end_time='23:59' for "available all day" — displayed as "All day", not the literal times.

**Idempotency:** None. Do not resubmit the same availability twice for the same conversation/message.

**Request body:**

| field | type | required | notes |
|---|---|---|---|
| `action` | "create" | yes |  |
| `date` | date (YYYY-MM-DD) | yes |  |
| `start_time` | time (HH:MM, 24h) | yes |  |
| `end_time` | time (HH:MM, 24h) | yes |  |
| `notes` | string | no |  |

**Response:** 201 with the created shift_request (status: pending, or denied immediately if it exceeds the owner's tier limit — see tierLimits.js).

### Re-propose the date/time on a still-pending availability entry

`PATCH /api/shift-requests/{id}  { date?, start_time?, end_time? }  (no "status" field)` — minimum role: **manager** — agent may call this

The calendar's drag-to-move: changes date/time on a request that is still pending — it stays pending either way, nothing is approved by moving it. Send only the fields you're changing; omitting "status" entirely is what routes this to reschedule instead of availability_review below.

**Idempotency:** Not applicable — safe to call again with the same values; only errors if the request is no longer pending.

**Request body:**

| field | type | required | notes |
|---|---|---|---|
| `date` | date (YYYY-MM-DD) | no |  |
| `start_time` | time (HH:MM) | no |  |
| `end_time` | time (HH:MM) | no |  |

**Response:** 200 with the updated shift_request. 409 if it's no longer pending.

### Approve or deny a pending availability entry

`PATCH /api/shift-requests/{id}  { "status": "approved" | "denied", "denial_reason"? }` — minimum role: **manager** — **human-only step, documented for context — do not call automatically**

Human-only — see the "Approval decisions are human-only" principle above. Approving here creates the actual `shifts` row; documented for context, not meant to be called automatically.

### Cancel a pending availability entry

`DELETE /api/shift-requests/{id}` — minimum role: **staff (own, pending only) or manager (any)** — agent may call this

Withdraws a still-pending availability submission. Errors if it has already been approved/denied.

### Add a shift directly to the schedule

`POST /api/shifts` — minimum role: **manager** — agent may call this

Creates a real, immediately-live scheduled shift — this is the Schedule Builder's own write path, not a request that needs later approval. Use this when a manager/admin has already decided who works when; use availability_create instead when a staff member is only reporting when they're free.

**Idempotency:** None — every call creates a new row. Do not call this twice for the same real-world shift.

**Request body:**

| field | type | required | notes |
|---|---|---|---|
| `user_id` | string | no | Resolve via GET /api/state → users. Omit/null for an unassigned shift. |
| `date` | date (YYYY-MM-DD) | yes |  |
| `start_time` | time (HH:MM) | yes |  |
| `end_time` | time (HH:MM) | yes | end_time <= start_time means the shift crosses midnight — do not "correct" it. |
| `department` | "FOH" | "BOH" | null | no |  |
| `notes` | string | no |  |

**Response:** 201 with the created shift.

### Move or edit an already-scheduled shift

`PATCH /api/shifts/{id}` — minimum role: **manager** — agent may call this

The calendar's drag-to-reschedule for an approved shift, or a direct correction (wrong time, wrong person assigned). Immediate — there is no separate approval step for an existing shift the way there is for a new availability entry.

**Idempotency:** Not applicable — send only the fields you're changing; omitted fields keep their current value.

**Request body:**

| field | type | required | notes |
|---|---|---|---|
| `user_id` | string | null | no |  |
| `date` | date (YYYY-MM-DD) | no |  |
| `start_time` | time (HH:MM) | no |  |
| `end_time` | time (HH:MM) | no |  |
| `department` | "FOH" | "BOH" | null | no |  |
| `notes` | string | no |  |

**Response:** 200 with the updated shift.

### Remove a shift from the schedule

`DELETE /api/shifts/{id}` — minimum role: **manager** — agent may call this

Immediate, no undo (short of recreating it) — only call this on an unambiguous, specific instruction ("take Jorge off Tuesday"), never from an inference.

### Submit a staff member's time-off request

`POST /api/timeoff` — minimum role: **staff** — agent may call this

Always submitted as the API key owner, same constraint as availability_create. The app's own UI shows a non-blocking warning for a start_date within 7 days of today ("may not be approved in time due to staffing constraints") — this endpoint does NOT enforce or return that warning itself, so if you're submitting this on someone's behalf and the date is close, say so to the human yourself rather than assuming the app will.

**Idempotency:** None.

**Request body:**

| field | type | required | notes |
|---|---|---|---|
| `start_date` | date (YYYY-MM-DD) | yes |  |
| `end_date` | date (YYYY-MM-DD) | yes |  |
| `reason` | string | no |  |

**Response:** 201 with the created time_off_requests row (status: pending, or denied immediately if it exceeds the owner's tier limit).

### Edit the dates/reason on a still-pending time-off request

`PATCH /api/timeoff/{id}  { start_date?, end_date?, reason? }  (no "status" field)` — minimum role: **staff (own, pending only) or manager (any)** — agent may call this

Corrects a still-pending request's own dates/reason — distinct from timeoff_review below, which decides it.

**Request body:**

| field | type | required | notes |
|---|---|---|---|
| `start_date` | date (YYYY-MM-DD) | no |  |
| `end_date` | date (YYYY-MM-DD) | no |  |
| `reason` | string | no |  |

**Response:** 200 with the updated row.

### Approve or deny a pending time-off request

`PATCH /api/timeoff/{id}  { "status": "approved" | "denied", "denial_reason"? }` — minimum role: **manager** — **human-only step, documented for context — do not call automatically**

Human-only — see the "Approval decisions are human-only" principle above.

### Cancel a time-off request

`DELETE /api/timeoff/{id}` — minimum role: **staff (own) or manager (any)** — agent may call this

Withdraws a request regardless of its current status.

### Create a recurring weekly shift template

`POST /api/admin/shift-templates` — minimum role: **manager** — agent may call this

Defines an ongoing coverage block (e.g. "Opener, 9am-3pm, Mon-Fri") that every future date's conflict/coverage checks run against. Changes standing policy, not a one-off event — only create one on an explicit, specific instruction.

**Request body:**

| field | type | required | notes |
|---|---|---|---|
| `name` | string | yes |  |
| `days_of_week` | array of 0-6 (Sun=0..Sat=6) | yes |  |
| `start_time` | time (HH:MM) | yes |  |
| `end_time` | time (HH:MM) | yes | end_time <= start_time means it crosses midnight. |
| `min_staff` | integer | no | Drives a non-blocking staffing warning if removing someone would drop below it. |
| `max_staff` | integer | no | Drives the Schedule Builder's conflict flag when exceeded. |

**Response:** 201 with the created template.

### Edit a shift template

`PATCH /api/admin/shift-templates/{id}` — minimum role: **manager** — agent may call this

Same fields as shift_template_create — send only what's changing.

### Delete a shift template

`DELETE /api/admin/shift-templates/{id}` — minimum role: **manager** — agent may call this

Removes the recurring coverage rule — existing shifts are untouched, only future conflict/coverage checks stop considering it.

### Post a shift for swap

`POST /api/swap/posts` — minimum role: **staff (own shift only) or manager (any)** — agent may call this

A staff-key caller can only post their own shift; a manager/admin key can post anyone's.

**Request body:**

| field | type | required | notes |
|---|---|---|---|
| `shift_id` | string | yes |  |
| `reason` | string | no |  |

**Response:** 201 with the created post (status: open).

### Cancel/close a swap post

`DELETE /api/swap/posts/{id}` — minimum role: **staff (own) or manager (any)** — agent may call this

Removes an open post from the board.

### Volunteer for a posted shift

`POST /api/swap/claims` — minimum role: **staff** — agent may call this

Blocked (409) if the slot is already at a day_caps max, or if the same key-owner already has a pending claim on that post.

**Request body:**

| field | type | required | notes |
|---|---|---|---|
| `post_id` | string | yes |  |
| `offer_shift_id` | string | no | One of the claimant's own shifts, offered back to the original poster. |

**Response:** 201 with the created claim (status: pending).

### Approve or deny a swap claim

`PATCH /api/swap/claims/{id}  { "status": "approved" | "denied" }` — minimum role: **manager** — **human-only step, documented for context — do not call automatically**

Human-only — finalizing a swap reassigns the shift between two real people; documented for context, not meant to be called automatically. As of the peak-staffing-mix work below, approval also re-checks the claimant's job qualification if the shift has a job_id — a claim can now be rejected (409) at approval time even if it was valid when claimed.

### List jobs/roles

`GET /api/admin/jobs` — minimum role: **manager** — agent may call this

Operational positions (e.g. "Shawarma Station", "Cashier") — distinct from a user's app role (staff/manager/admin). Resolve a job_id against this before calling any of the job-qualification/proficiency/requirement actions below; also returned in GET /api/state's `jobs` array for every role, not just manager-and-up.

### Create a job/role

`POST /api/admin/jobs` — minimum role: **manager** — agent may call this

Same "never invent" caution as shift_template_create — a job is standing operational structure everyone's qualification/scheduling gets checked against; only create one on an explicit, specific instruction, never a guess.

**Request body:**

| field | type | required | notes |
|---|---|---|---|
| `name` | string | yes |  |
| `department` | string | no |  |

**Response:** 201 with the created job.

### Edit or disable a job

`PATCH /api/admin/jobs/{id}` — minimum role: **manager** — agent may call this

Same fields as job_create, plus disabled (boolean) to retire a job without deleting its history.

### Delete a job

`DELETE /api/admin/jobs/{id}` — minimum role: **manager** — agent may call this

Cascades: removes everyone's qualification and proficiency for this job too. Prefer job_update with disabled: true unless a human specifically asks to delete it outright.

### Set an employee's qualification for a job

`POST /api/admin/employee-jobs` — minimum role: **manager** — agent may call this

Gates whether this person can be scheduled into the job at all — only 'qualified' satisfies a hard requirement (see template_requirement_set). Relay an explicit human decision verbatim ("mark Jorge qualified for Shawarma Station") — never infer or guess someone's qualification yourself. Demoting below 'qualified' automatically clears any proficiency tier already set for that job+person (see employee_role_profile_set) — mention this side effect if a human asks you to demote someone who currently has one.

**Idempotency:** Upserts by (user_id, job_id) — safe to resubmit the same state.

**Request body:**

| field | type | required | notes |
|---|---|---|---|
| `user_id` | string | yes | Resolve via GET /api/state → users. |
| `job_id` | string | yes |  |
| `qualification_state` | "not_qualified" | "training" | "qualified" | yes |  |
| `effective_date` | date (YYYY-MM-DD) | no | Defaults to today. |

**Response:** 201 with the employee_jobs row.

### Remove an employee's qualification record for a job entirely

`DELETE /api/admin/employee-jobs  { user_id, job_id }` — minimum role: **manager** — agent may call this

Different from setting qualification_state to 'not_qualified' — this removes the record (and any proficiency profile) entirely, as if the job/person link never existed. Prefer employee_job_set with 'not_qualified' unless a human specifically wants the record gone.

### Set an employee's role-specific proficiency tier

`POST /api/admin/employee-role-profiles` — minimum role: **manager** — agent may call this

Deliberately NOT a single global "good/bad employee" score — tracked per job. Requires the employee already be 'qualified' for that job (400 otherwise: resolve with employee_job_set first). This is a performance judgment about a real person's scheduling opportunity — relay an explicit human assessment verbatim ("Sanaa is Advanced at Shawarma Station now"), never infer or estimate a proficiency tier yourself from indirect signals.

**Idempotency:** Upserts by (user_id, job_id) — safe to resubmit the same state.

**Request body:**

| field | type | required | notes |
|---|---|---|---|
| `user_id` | string | yes |  |
| `job_id` | string | yes |  |
| `proficiency` | "developing" | "proficient" | "advanced" | yes |  |
| `effective_date` | date (YYYY-MM-DD) | no |  |
| `source` | string | no | Free text provenance, e.g. "Manager review 2026-09". |

**Response:** 201 with the profile row. 400 if the employee isn't 'qualified' for that job yet.

### Clear an employee's proficiency tier for a job

`DELETE /api/admin/employee-role-profiles  { user_id, job_id }` — minimum role: **manager** — agent may call this

Removes the tier without touching the underlying qualification (employee_jobs) — they remain qualified, just with no proficiency recorded.

### Submit a recurring weekly availability window

`POST /api/availability` — minimum role: **staff** — agent may call this

NOT the same thing as availability_create above — that endpoint (/api/shift-requests) is a date-specific "I'm free this one day" ask that becomes a real shift once approved. This is a standing weekly pattern ("never available Tuesdays," "free 9-5 every Wednesday") with no approval step and no direct scheduling effect by itself — it's read by GET /api/state's `availabilityMine` for the caller, and by the auto-generation optimizer in a future integration. Always submitted as the API key owner.

**Idempotency:** None — resubmitting creates an additional row, it does not replace one. Track what you've already submitted.

**Request body:**

| field | type | required | notes |
|---|---|---|---|
| `day_of_week` | integer 0 (Sunday) - 6 (Saturday) | yes |  |
| `start_time` | time (HH:MM) | yes |  |
| `end_time` | time (HH:MM) | yes |  |
| `effective_from` | date (YYYY-MM-DD) | no | Omit for "no start bound". |
| `effective_to` | date (YYYY-MM-DD) | no | Omit for "ongoing". |

**Response:** 201 with the created rule.

### Delete a recurring availability rule

`DELETE /api/availability/{id}` — minimum role: **staff (own) or manager (any)** — agent may call this

Removes one weekly-pattern row (not a whole day's worth — a person can have several overlapping-day rules).

### Set a peak-staffing-mix requirement for a shift template + job

`POST /api/admin/shift-templates/{id}/requirements` — minimum role: **manager** — agent may call this

E.g. "Friday dinner needs at least one Advanced Shawarma Station person and three Proficient-or-better." min_count is the plain headcount for that job on that template; the other two are layered minimums within that headcount (advanced counts toward proficient-or-better too, not as a separate bucket). Changes standing weekly policy, like shift_template_create — only on an explicit, specific instruction.

**Idempotency:** Upserts by (shift_template_id, job_id) — safe to resubmit the same state.

**Request body:**

| field | type | required | notes |
|---|---|---|---|
| `job_id` | string | yes |  |
| `min_count` | integer >= 0 | no | Defaults to 0. |
| `min_advanced_count` | integer >= 0 | no | Defaults to 0. |
| `min_proficient_or_better_count` | integer >= 0 | no | Defaults to 0. |

**Response:** 201 with the requirement row.

### Remove a peak-staffing-mix requirement

`DELETE /api/admin/shift-templates/{id}/requirements  { job_id }` — minimum role: **manager** — agent may call this

That job goes back to having no mix requirement on this template (but any min_staff/max_staff on the template itself is untouched).

### Check whether a template's peak-staffing-mix is satisfied on a given date

`GET /api/admin/shift-templates/{id}/coverage-check?date=YYYY-MM-DD` — minimum role: **manager** — agent may call this

Read-only. Returns, per job requirement, actual vs. required headcount/advanced/proficient-plus counts and any gaps (REQUIRED_COVERAGE_GAP, MIN_PROFICIENCY_MIX_GAP) — useful context before telling a human a Friday is fully covered, or isn't.

### Generate a candidate schedule for a date

`POST /api/admin/schedule/generate` — minimum role: **manager** — agent may call this

Read-only in effect — writes only an audit snapshot of the proposal (schedule_generations), never a real shift. Derives ShiftSlots from that date's shift_templates × their peak-staffing-mix requirements (falling back to a job-agnostic slot sized to min_staff for a template with none configured), then runs the optimizer: hard eligibility/availability/no-double-booking first, then mandatory proficiency mix, then generic fill favoring whoever has fewer hours already this week. Present the result (assignments + any unfilled gaps) to a manager — do not describe it as already scheduled, nothing is live yet.

**Request body:**

| field | type | required | notes |
|---|---|---|---|
| `date` | date (YYYY-MM-DD) | yes |  |

**Response:** 200 with { generation_id, slots, assignments, unfilled }. Each assignment includes reason_codes explaining why that person was picked.

### Apply an accepted candidate-schedule proposal

`POST /api/admin/schedule/apply` — minimum role: **manager** — **human-only step, documented for context — do not call automatically**

Human-only — this is the actual publish step that turns a proposal into real, live shifts (potentially many at once). The PRD this feature implements is explicit that the optimizer/AI never publishes autonomously; a manager reviews the schedule_generate proposal and applies it themselves from the app, or gives you an unambiguous, specific instruction to do so for a proposal they've already seen and named ("apply generation X exactly as shown") — never apply a proposal on your own initiative or from a vague "go ahead and schedule Friday."

### List past schedule-generation proposals (audit trail)

`GET /api/admin/schedule/generations?date=YYYY-MM-DD` — minimum role: **manager** — agent may call this

Read-only history of what the optimizer has proposed and what was actually applied, by whom, and when — useful context, not itself a write.

### Submit actual worked time (clock-in/out) from a POS or timeclock

`POST /api/public/actual-shifts` — minimum role: **staff (any valid API key)** — agent may call this

See the "you are the adapter" principle above — translate whatever the business's actual POS/timeclock report contains into this shape yourself. Kept separate from the `shifts` table on purpose: this records what actually happened, `shifts` records what was scheduled, and reliability_read (below) compares the two. shift_id is optional — omit it rather than guessing if you're not confident which scheduled shift a punch corresponds to; the reliability calculation falls back to same-date matching on its own.

**Idempotency:** Pass external_ref (the source system's own id for that punch) when it has one — the pair (source, external_ref) is deduplicated at the database level, so resubmitting the same batch is safe. A source with no stable per-punch id has no dedup protection; note that to whoever asked you to submit it.

**Request body:**

| field | type | required | notes |
|---|---|---|---|
| `source` | string | yes | e.g. "toast", "square", "clover", "manual" — name what it actually is. |
| `rows` | array (max 1000) | yes | Each: { user_id, date, clock_in, clock_out?, shift_id?, external_ref? }. |

**Response:** 201 with { created, skippedDuplicate, import_id }. 400 with rowErrors (all-or-nothing — nothing is written if any row fails validation) if a user_id/date/time is missing or malformed.

### GPS-verified self check-in / check-out

`POST /api/checkin  { "action": "in" | "out", "lat", "lng", "date", "time" }` — minimum role: **staff (own session only — not reachable with an API key at all; not under /api/public or /api/admin)** — **human-only step, documented for context — do not call automatically**

Human-only, deliberately excluded from API-key access entirely — this proves a real person's phone was physically at the restaurant at this exact moment (server-side haversine distance check against the location's stored geofence, src/lib/geo.js). An agent calling this on someone's behalf, even with honestly-relayed coordinates, defeats the entire point of the feature — there is no legitimate agent use case here, unlike availability_review above (which at least has a real human decision behind it an agent could theoretically relay). Writes to actual_worked_shifts with source='self_checkin', alongside the raw lat/lng/distance for audit. Documented here only so an agent understands why "just check me in" from a person in conversation must be declined and redirected to the app.

### Read one employee's factual reliability record over a date range

`GET /api/admin/reliability?user_id=&date_from=&date_to=` — minimum role: **manager** — agent may call this

Read-only. Returns named counts (on_time_count, late_count, no_show_count, on_time_pct) computed from scheduled shifts vs. actual_shift_import data — deliberately not a single score (PRD section 4.2). Useful context before answering a question like "has Jorge been reliable lately," but relay the actual numbers, don't summarize them into your own good/bad verdict.

## Bulk schedule import

For loading a whole schedule at once (a spreadsheet, a photo of a handwritten schedule, a pasted message spanning many shifts) instead of one-row-at-a-time direct-action calls. One batch can mix all four row types below.

- Call with an API key: `POST /api/public/shift-imports  (Authorization: Bearer shwrm_xxxxx)`
- Or with an admin/manager session (the Manage UI's own path): `POST /api/admin/shift-imports  (admin/manager session — used by the Manage UI)`
- Content-Type: text/csv (raw CSV body) or application/json  { filename?, rows: [...] }
- Get the current roster (for name matching) first: `GET /api/admin/shift-import-template  (a live CSV with the current roster in a comment header)`
- Max 1000 rows per batch. All-or-nothing: if any row fails validation, nothing is written and every error is returned so the whole batch can be fixed and resubmitted.

| type | columns | notes |
|---|---|---|
| `shift` | username, date, start_time, end_time, notes | Creates an actual, immediately-live scheduled shift (not a pending availability entry). No idempotency key — resubmitting the same batch creates duplicate shifts. |
| `cap` | date, window_start, window_end, max_shifts, notes | A one-off exception on a single date/window (separate from a recurring shift_template). Upserted by (date, window_start, window_end) — safe to resubmit. |
| `swap` | username, date, start_time, notes (= swap reason) | Posts an EXISTING shift (matched by username+date+start_time) for swap — errors if no such shift exists yet. No idempotency key — resubmitting posts it again. |
| `template` | name, days_of_week, start_time, end_time, min_staff, max_staff | Creates or updates a recurring weekly shift_template. days_of_week is 0(Sun)-6(Sat), separated by comma, space, or "|" (e.g. "1 2 3 4 5"). Matched and upserted by exact `name` — importing the same name again UPDATES it in place, safe to resubmit. |

Name matching (the `username` column on `shift`/`swap` rows) is fuzzy on purpose: it accepts the exact system username, a full display name, or a first name — a first name shared by two people is treated as ambiguous and errors rather than guessing.

