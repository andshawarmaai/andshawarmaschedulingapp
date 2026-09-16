<!--
GENERATED from src/lib/agentGuide/registry.js (see that file's header comment for why).
Do not hand-edit the sections below — regenerate instead. Prefer fetching this live:
GET /api/agent-guide/markdown from the specific deployment you're talking to
(see CLAUDE.md §2 for which URL that is for this app's two deployments).
-->

# &Shawarma Scheduling — Agent Integration Guide

This document tells an AI agent (or any other system authenticating with an API key) how to safely read and write schedule data in this app. It is generated from the app's own action registry (`src/lib/agentGuide/registry.js`), so it stays in sync with what the API actually does — fetch it live at `GET /api/agent-guide/markdown` rather than keeping a stale copy. See `CLAUDE.md` in the app repository for the full schema, business rules, and deployment context this guide assumes.

## Ground rules

**Approval decisions are human-only.** Availability requests, time-off requests, and swap claims all land pending and stay that way until a human approves or denies them from the Schedule Builder (or the Time Off / Shift Swap pages). Never call an approve/deny endpoint yourself, even if a manager says 'approve it' in conversation — tell them it's ready for their review and where to find it, or at most confirm you understand what they want before nudging them to actually click it. This is a deliberate design choice (see CLAUDE.md §4), not an oversight.

**Direct shift/template writes are immediate — no review queue.** Unlike availability, POST /api/shifts, PATCH/DELETE on an existing shift, and all shift_templates writes go live the moment you call them — there is nothing pending to approve afterward. Only call these when you are confident (a clear, specific instruction from an admin/manager), not from an inference about what someone probably meant.

**Never invent people, never invent templates.** Resolve a name against GET /api/state's `users` array (or the bulk-import template's roster comment) before referencing a user_id — match on username, exact display name, or first name, and if more than one person shares that first name, ask rather than guessing which one. Do not create a new user account (out of scope for this API entirely — that stays a human, in-app action). Creating a new shift_template changes ongoing weekly coverage rules for everyone; only do it on an explicit, specific instruction, never as a guess at what a schedule "probably" needs.

**Idempotency is mostly your responsibility.** Almost nothing below has a database-enforced dedup key (day_caps upserts by date+window are the one exception). A retried or resent instruction WILL create a second shift, a second availability entry, or a second swap post if you call the same write twice — track what you've already submitted for a given conversation/message yourself, the API will not catch a duplicate for you. Within /api/public/shift-imports, `cap` rows upsert by (date, window_start, window_end) and `template` rows upsert by exact name, so both are safe to resubmit — `shift` and `swap` rows have no dedup key at all and WILL duplicate on a resubmit.

**Authentication.** Every call below uses an API key created via POST /api/admin/api-keys (admin session) or the Manage → API Keys card in the UI: header Authorization: Bearer shwrm_xxxxx. The key resolves to the real user who created it and acts with that user's exact role and identity — there is no separate "service account" concept, and a write is attributed to that real person just as if they'd clicked it themselves. A 403 means the key's owner does not hold the role a given action requires — create the key from an account with sufficient role rather than trying to escalate.

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

Human-only — finalizing a swap reassigns the shift between two real people; documented for context, not meant to be called automatically.

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
