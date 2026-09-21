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
week/month at once. **Fetch it live from the deployment itself** (§2 has
the URL) rather than trusting a stale local copy.

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

## 2. Deployment topology

**Corrected 2026-09-18 — the two-repo split documented below until now was
stale.** This checkout's actual remote is `therayally/work-buddy-scheduling-
advanced` (not `andshawarmaai/andshawarmaschedulingapp` or `therayally/
andshawarmatest`, whatever this section used to say), and its linked Vercel
project is `work-buddy-scheduling-advanced`, confirmed as the current one
directly by the owner. One repo, one Vercel project, one Neon database —
not two of everything, contrary to this section's old header.

| Repo | Vercel project | Live URL |
|---|---|---|
| `therayally/work-buddy-scheduling-advanced` (remote `origin`) | `work-buddy-scheduling-advanced` (`.vercel/project.json`) | https://work-buddy-scheduling-advanced.vercel.app |

```bash
git push origin main
vercel --prod --yes   # deploys+aliases whichever project .vercel/project.json points at
```

An `andshawarmatest` Vercel project still exists (`https://andshawarmatest.
vercel.app`) but was NOT updated by this session and its relationship to
this checkout is unconfirmed — don't assume it's a live mirror of this one
or push/deploy to it without checking with the owner first.

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
- **`day_caps`** — a one-off exception on a single date/window (`date, window_start, window_end, max_shifts, note`), separate from the recurring `shift_templates`. **The "Slot Caps" Manage-page UI for creating/clearing these was removed 2026-09-16** (the owner found it redundant with Shift Templates, which already covers "how many people, what times") — the data model, `/api/admin/day-caps`, and `type=cap` bulk-import rows are all still fully functional, there's just no manual form for it any more. Create one via a bulk import or have an agent do it if it's ever needed again.
- **`api_keys`** — programmatic access for an external agent (see §5). `label, key_prefix, key_hash, created_by, last_used_at, revoked`. The raw key is shown exactly once at creation.
- **`password_reset_requests`** — there's no email sender; "Forgot password?" files a row here for an admin to see and resolve manually.
- **`locations`** — Sprint 1's multi-location foundation, still single-restaurant in practice ("a NULL location means the single default location until an admin actually splits locations apart" — schema.sql). Added this session: `lat, lng, geofence_radius_meters` (all `DOUBLE PRECISION`/`INTEGER`, all `NULL` until an admin sets them via Manage → Location Check-In) — `db.getPrimaryLocation()` (the oldest non-disabled row) is what GPS check-in and the geofence-config API both read/write against, so nothing needed `users.location_id` populated.
- **`actual_worked_shifts`** gained six columns this session: `clock_in_lat/lng/distance_meters`, `clock_out_lat/lng/distance_meters` (all `DOUBLE PRECISION`, `NULL` on every row except `source='self_checkin'`) — the raw GPS reading and computed distance from the geofence center at each punch, kept as an audit trail rather than only a pass/fail. See `src/lib/geo.js` (`distanceMeters`/`checkGeofence`, haversine, pure and unit-tested — `test/geo.test.js`) and `POST /api/checkin`.

## 4. Business rules already built (don't rebuild or contradict these)

- **Staff submit availability, not shift requests.** The staff-facing `schedule.astro` card is "My Availability" — days/times they're available, including "available all day". There is **no approve/deny control anywhere in the staff UI**; staff only ever see a status badge and a Cancel button on their own pending items.
- **Only the Schedule Builder (`admin/schedule.astro`) approves/denies/schedules — including undoing an already-approved time-off block.** Admin/manager see pending availability + pending AND approved time off + already-approved shifts all on one calendar (Month/Week/Day views), and can: right-click a pending item to approve/deny, right-click an approved shift or approved time-off (solid indigo, vs. pending time-off's lighter tint) to remove it from the schedule, and **drag a shift or a pending request — but not time off, which spans a date range — onto another day to move it**. Dragging a pending request PATCHes `/api/shift-requests/:id`; dragging an approved shift PATCHes `/api/shifts/:id`; removing approved time off is `DELETE /api/timeoff/:id` (no status restriction on that endpoint — it was always capable of this, the calendar just didn't surface approved time off at all before this was added). The plain staff schedule page (`schedule.astro`) is deliberately read-only for time off — an admin who wants to undo an approved one comes here, on purpose, so there's one editing surface, not two. This whole page is gated admin/manager-only by `middleware.js`.
- **Adding a shift directly (not waiting on someone's submitted availability) also only happens here.** A "+" appears on hover over a Month cell or a Week day header (hidden the rest of the time so a full month grid doesn't look cluttered with 35+ buttons); Day view has the same thing as an always-visible "+ Add shift" button instead, since only one date is ever on screen there. Either opens the same small modal (staff picker, date, start/end time, notes) used for both add and edit — `POST /api/shifts` when adding.
- **Clicking an already-scheduled (green) shift chip/bar opens that same modal in edit mode** (prefilled, `PATCH /api/shifts/:id` on save, plus a Delete button as an alternative to the right-click menu) — for changing the time, assigned staff, or notes without re-creating it. Dragging still does a quick date-only move; a completed native HTML5 drag never also fires the element's `click` (the browser suppresses it), so the two coexist without fighting each other.
- **The Schedule Builder's usage instructions live in a "❓ How to use this" popup**, not a permanent paragraph on the page — a plain bulleted `<ul>` in a modal, same content as before just out of the way until asked for.
- **Both `schedule.astro` (staff) and `admin/schedule.astro` have a "🖨️ Print / Save as PDF" button** — plain `window.print()` plus a `@media print` stylesheet. No PDF library: every major browser's print dialog already offers "Save as PDF" as a destination, so this covers both "print" and "export a PDF" from one button with zero new dependencies.
- **The printed/exported output is a dedicated, page-sized SHEET, never a printout of the on-screen interactive calendar** (rebuilt 2026-09-16 after the original version just let the whole page print, sidebar-remnants and all, looking like "printing a Gmail thread"). `@page { size: letter landscape; margin: 0.5in }` sets a real 8.5×11 default (the print dialog can still flip to portrait). `main.app-page > *:not(.print-keep) { display:none !important }` hides every OTHER direct child of the page's main content in print by default — toolbars, cards, the interactive calendar — so nothing stray ever bleeds onto the page; the one element tagged `.print-keep` (`#cal-print-sheet` on the admin page, `#print-shift-list` on the staff page) is a self-contained sheet built fresh by JS right before printing (`renderPrintSheet()` / `renderPrintMonthGrid()`+`renderPrintList()`), not reused DOM from the screen. Each sheet has: a header (business name + month/year), a clean static month-grid `<table>` (`.print-month-grid`) with compact per-cell times (`compactTimeLabel()` — "9a-6p", "4:30p-2:30a"; the normal 12-hour format doesn't fit next to a name in a ~1.4in-wide grid column), and a plain shift-list `<table>` below it in the full 12-hour format, which has real room. The admin sheet always prints the MONTH containing whatever date `anchor` is on, regardless of Month/Week/Day view; the staff sheet does the same with `viewYear`/`viewMonth`. **If you add a new page's print feature, give its print-only root the `print-keep` class too** — without it, the new blanket-hide rule silently hides that content in print instead of showing it (this rule intentionally applies to every page sharing `main.app-page`, including ones with no print feature at all — hitting Cmd+P there now prints an empty body instead of the old messy full-page dump, which was never a supported flow anyway).
- **The Schedule Builder also has an "⬇️ Export to spreadsheet" button** — downloads a CSV of the durable schedule data (`shifts`, `dayCaps`, `shiftTemplates`; deliberately *not* pending requests/time-off/swaps, which are in-flight workflow state, not durable structure) in exactly the row shape `/api/public/shift-imports` and `/api/admin/shift-imports` accept, so it doubles as a backup — the same file can be re-imported later. Verified round-trip: export → `parseCsv` → `validateImportRows` reproduces the original data exactly, including a note field containing both a comma and embedded quotes.
- **Conflict flagging covers both pending and approved.** `computeShiftRequestConflicts` (client) and the server-side coverage checks both treat a template's `max_staff`/`min_staff` against the combined set of approved shifts + pending requests for that date+window — not pending-only.
- **Tier limits hard-deny; coverage checks only warn.** A tier's monthly cap (`tierLimits.js`) blocks a create outright with a denial reason. A `min_staff` coverage check (`coverage.js`) only attaches a `staffing_warning` string — the request still goes to Pending for a human to decide with full context.
- **Time off within 7 days shows a non-blocking warning** ("may not be approved in time due to staffing constraints") on the request form — it does not block submission; it still goes through the normal admin approve/deny flow. (Added because staff sometimes request time off for personal appointments last-minute; the owner wants them warned, not blocked.)
- **Visual conventions on the Schedule Builder calendar**: white/outlined = pending, green = scheduled (approved), red = conflict (overrides the pending/scheduled color), blue = time off.
- **Dragging a shift or pending request to a new date now asks for confirmation first** ("Move {name}'s shift/pending request to {date}?", a plain `confirm()`, matching the existing delete/approve confirmation style) — a single accidental drag used to silently move someone with no way to tell it happened.
- **An "Undo" button sits right above the calendar** (also Cmd/Ctrl+Z, ignored while typing in a field) and can roll back any number of steps this session, most-recent-first: moving, adding, editing, or deleting a shift. Each action pushes its own exact-reverse call onto an in-memory stack (`pushUndo`/`undoLast` in `admin/schedule.astro`) — cleared on page reload, no server-side history. **Deliberately does not cover approve/deny or time off** — those are one-way decisions with their own confirmation already (deny prompts for a reason), and reversing an approval would mean untangling the `shifts` row it created too; out of scope for now.
- **Hovering a red conflict flag shows a real popup explaining why, in plain English** (`showConflictTooltip`/`.conflict-tooltip` in `admin/schedule.astro`/`global.css`) — not the browser's own slow, easy-to-miss `title` tooltip. Flagged chips/bars carry the note in `data-conflict-note` instead of `title` for this reason; non-flagged items (the plain "click to edit, drag to move" hint) still just use `title`, since that one's minor and not urgent.
- **Day view (2026-09-20 rewrite): one column per shift template, not one per person, and the panel/timeline can never disagree.** Old system (ghost items, `packNoReuse`, per-lane sub-range boxes) is gone — real, reported problems: "three columns for the same 9-9 block" (compression as headcount grew) and "these are independent shifts... one shift template does not pull math or people from another shift template" (the old panel's ANY-OVERLAP sweep let an unrelated overlapping template inflate another's headcount, e.g. a 9am-6pm shift showing as "2 of 1, over capacity" on a completely separate 10:30am-9:30pm template with zero shifts actually assigned). Both the coverage panel (`computeDayCoverage`) and the timeline (`dayTemplateBarsHtml`/`templateColumnHtml`) now derive from the SAME function, `groupDayItemsByTemplate` (`client/coverage.js`) — best-fit containment only (a shift belongs to exactly one template, same rule `computeShiftRequestConflicts` already used), approved shifts only (pending never counts, same "a pending request must never count toward closing a gap" rule as before). A template column is sized to the template's own declared start/end (not a fragmented sub-range), holding one row per person — approved, "Unapproved" (pending, with an inline Approve button plus the usual right-click approve/deny), or an empty `+ Add` placeholder up to `max(min_staff, max_staff, actual headcount)`. Anything that fits no template still gets its own individual column, unchanged. Week view is untouched (still `dayBarsHtml`/`packOverlaps`).
  - **Dropping/clicking a selected name onto a `.template-slot-empty` saves the shift immediately, no modal** — the slot already names the exact template + time, nothing left to review. `.coverage-block` (the summary card above) still opens the modal on drop, unchanged; right-click on either always opens the modal (a deliberate "configure this manually" path).
  - **The "Time off" row now has its own soft background + a heavier bottom border, AND Day view has a second, explicitly-labeled "Shift times" row right below it, right above the hour rail** — fixed 2026-09-16 after a real reported confusion: "that word time off is not correct. This is the shift times." "Time off" itself turned out to be correct (it does list people actually taking time off that day) — the real problem was that the hour rail/timeline directly below it had NO label of its own at all, so at a glance it was ambiguous whose row you were looking at. Both rows now share the same `.cal-timeoff-row`/`.cal-timeoff-label` styling (soft background, heavier border) for a consistent look, with the second one just captioned "Shift times" and an empty cell instead of `toChips`.
  - **Dragging an approved shift back OUT onto the Day view's roster-name row un-commits it to pending** — the reverse of dragging a name IN to fill a slot, added 2026-09-16 ("Is there no way to drag a staff member out of the shift box... put it back to pending status?"). `wireCoverageInteractions` wires `.coverage-roster` itself as a drop target for `kind === 'shift-approved'`: on drop (after a `confirm()`), `POST /api/shifts/:id/revert-to-pending` calls the new `db.revertShiftToPending(shiftId)` (in both `local.js` and `neon.js`), which creates a fresh `shift_requests` row (status `pending`, action `create`, same user/date/time/notes) and deletes the `shifts` row (plus any swap post referencing it). Works uniformly whether the shift originally came from an approved request (whose own `shift_requests` row stays around with status `approved` — stale history, nothing reads it) or was added directly by an admin. Deliberately bypasses tier-limit checks — this isn't a new commitment being requested, it's an existing one being undone, so it should never be blocked the way a fresh `POST /api/shift-requests` could be. Not undo-tracked, consistent with approve/deny being out of Undo's scope. **Needs a shift template applying to that date for the roster row to even render** (`renderCoveragePanel` returns nothing when there's no applicable template) — on a date with zero templates, this drop target isn't available at all; there's no separate always-present roster list to fall back on.
  - **The Manage page's "Pending Approvals" card now links to Schedule Builder** (`admin.astro`, added 2026-09-16) — the heading text and a line in the card's subtitle both link to `/admin/schedule`. The card's own inline Approve/Deny buttons and list are UNTOUCHED (still fully functional) even though §4 above says approve/deny "only" happens in Schedule Builder — this card predates that rule and still works, so it wasn't ripped out on top of adding the link; flagging this as a known inconsistency worth resolving deliberately later rather than silently.
  - **A pending availability request must NEVER shrink or close a coverage gap on its own — only an APPROVED shift does.** Real, reported bug, fixed 2026-09-16: `rowsForSweep` (`client/coverage.js`), used by both `computeDayCoverage` and `computeTemplateTimeGaps`, used to fold in pending `shift_requests` alongside approved `shifts`, so the moment a staff member submitted availability that overlapped an open slot, the slot's red gap would shrink or vanish with zero admin action — reading exactly like the app had silently auto-assigned it. The owner's own words: "there might be four people asking for the same time slot and we don't want to auto-assign them yet." Fix: `rowsForSweep` now only ever includes `shifts` (approved). The pending request still renders as its own chip/bar on the timeline (`dayBarsHtml` includes `pendingShiftReqs` independently of the sweep) and still counts toward `computeShiftRequestConflicts`' max_staff over-capacity flag (deliberately unchanged — combining pending+approved there answers a different question, "too many people, decided or not") — it just can't satisfy a min_staff gap by itself any more. The admin still fills a gap the same deliberate way as always: drag a roster name or an existing pending request onto the block (see the two-path fill + drag-approve notes above), which are unaffected by this fix.
- **A gap segment landing entirely past midnight must be filled with a shift dated the NEXT calendar day, not the day being viewed** — a segment whose raw minutes are ≥1440 converts to an ordinary-looking HH:MM range (e.g. "01:30-02:30") that, dated `iso`, would silently record as early THIS morning instead of the actual overnight tail (`computeGhostItems`'s day-bump, `addDays` in `admin/schedule.astro`). Correspondingly, when sweeping a date's coverage, a shift dated the FOLLOWING day that starts very early is folded back in shifted +24h (`rowsForSweep` in `client/coverage.js`) — otherwise a shift created specifically to fill that overnight tail would be invisible to that date's own coverage check and the red block would never clear. Both sides of this same fix shipped together; a change to one without the other will reintroduce either a wrong-date bug or a gap that can't be filled.
- **The Add/Edit Shift modal has "quick fill" buttons for whichever shift templates apply to the selected date** (`renderTemplatePicker` in `admin/schedule.astro`) — one pill per matching template (filtered by day-of-week, re-filtered whenever the Date field changes), which sets Start/End to that template's exact times on click. Start/End stay freely editable below it for a genuinely custom shift; this is purely a shortcut, not a constraint.
- **The staff-facing "Show availability" editor (`schedule.astro`) has the same quick-fill picker** (`renderEditorTemplatePicker`, added 2026-09-16) — a staff member can click a template pill instead of typing custom times, same day-of-week filtering, same shortcut-not-constraint relationship with the free-typed Start/End fields below it. This is why `shiftTemplates` had to move to the "everyone" tier of `GET /api/state` (see §6) — staff couldn't previously see template data at all.
- **Filling a coverage block/open slot has two independent paths, and BOTH open the Add Shift modal pre-filled rather than saving instantly**: drag a roster name onto it, or click a name to arm it (`.roster-chip.selected`) then click a block. Dropping used to save immediately; it doesn't any more — native HTML5 drag-and-drop isn't reliable on every trackpad/browser combination, so a silent instant save gave no visible confirmation a drag even registered, and either way an admin should get a chance to check/adjust the time before it's scheduled. `selectedRosterUserId` in `admin/schedule.astro` tracks the click-armed name; it's cleared on every render and after each use.
- **A THIRD thing is also droppable onto a coverage block/open slot: an existing pending request** (a `.req-chip`/`.req-bar`, `application/x-kind: 'shift-pending'`) — dropping one there approves it immediately (`PATCH /api/shift-requests/:id { status: 'approved' }`), no modal, since the whole point is visually confirming "yes, this person for this slot" for a request that's often already sitting right next to (or straddling) the open slot it could fill. **Critically, this approves the request at the hours the staff member actually asked for — never stretched to the block's full time.** If those hours don't cover the whole block, the remainder correctly stays its own red open slot afterward — no special-casing needed, since `computeGhostItems`'s instant-by-instant sweep already treats a partially-covered window as "some of it still needs someone." Not undo-tracked, consistent with the rest of approve/deny being out of undo's scope.
- **A shift template's `min_staff` is what actually drives every "needs coverage" signal** — the coverage panel's under/filled status, the Day view's open-slot blocks, all of it. `max_staff` alone (no minimum) produces a `neutral` status and zero open slots no matter how empty the day is; there's no minimum to be short of. When staffing numbers from a customer read like "1 Person"/"3 Person" (a fixed target, not just a ceiling), set BOTH `min_staff` and `max_staff` to that number — setting only `max_staff` (an early mistake on the demo data) makes the whole coverage-gap feature silently do nothing.
- **A denied availability entry must be explicitly acknowledged by the staff member before it disappears** — a "✓ Got it" button next to it on `schedule.astro`'s "My Availability" list `DELETE`s the `shift_requests` row (same endpoint pending's Cancel button already used; the old `if (req.status !== 'pending') return 409` restriction on that DELETE was removed so this works, matching `/api/timeoff/[id].js`'s DELETE, which never had that restriction). No auto-expiry by time or by login count — the owner explicitly wants a deliberate click, not something that just silently ages out, so a denied row is never actually gone until the person has actually seen and dismissed it.
- **Every signed-in user (staff included) has a "Settings" page** (`src/pages/settings.astro`, nav key `settings`) to update their own contact info (email/phone) and change their own password — deliberately separate from Manage → Users (admin/manager-only, and able to touch role/disabled/tier_id/anyone's row). It hits a new self-service route, `PATCH /api/me`, which is NOT under an `ADMIN_ONLY_PREFIX` in `middleware.js` so any authenticated caller can reach it, but only ever touches the caller's own row — never accepts a target user id. Changing the password requires the correct `current_password` (bcrypt-compared server-side) before a `new_password` is accepted; nothing about the current session is invalidated (existing behavior of `db.updateUser`'s password path), so the user stays logged in and the new password takes effect on their next login.
  - **`data.me` from `GET /api/state` is decoded straight from the session token (set at login) and never carries `email`/`phone`** — a page needing the CALLER's own current contact info must look itself up in `data.users` (the live DB read) by `data.me.id` instead, the way `settings.astro`'s `loadState()` does, or it'll show stale/blank fields regardless of whether a save actually worked. This bit `settings.astro` itself during development — the save was succeeding the whole time, only the read-back was wrong.
  - **Fixed a real bug in `neon.js`'s `updateUser` while building this**: `phone`/`email` used `updates.x ?? u.x`, which treats an explicit `null` (clearing the field) as "no change" and silently keeps the old value — the same class of bug the function's own `tier_id` handling already correctly avoided via `!== undefined`. Both fields now use that same pattern. `local.js` never had this bug (already used `!== undefined`).
- **GPS-verified self check-in (added this session) is a single location reading at the moment of the tap, never ongoing tracking.** The owner's own framing: "when they hit check-in, they are actually at their location with a GPS coordinate" — one `navigator.geolocation.getCurrentPosition()` call on button press, nothing running in the background. `index.astro`'s Check In/Check Out card is hidden entirely (`checkInAvailable` in `GET /api/state`) until an admin sets lat/lng/radius in Manage → Location Check-In — a half-configured feature never shows to staff. Distance validation is 100% server-side (`POST /api/checkin`, `src/lib/geo.js`'s haversine `checkGeofence`) — the client only ever sends its raw coordinates, never the target location's, so there's nothing for a client-side check to spoof around. Outside the radius → 403 with the actual distance in the message, not a vague "try again." A location with `geofence_radius_meters IS NULL` fails closed (`isGeofenceConfigured`), not open — "not set up" and "set up with a 0m radius" are deliberately distinct states.
  - **This is human-only, and deliberately not reachable by an API key at all** — see `self_checkin` in `agentGuide/registry.js` (`agentMayCall: false`, and genuinely excluded from `/api/public`/`/api/admin`, not just discouraged). An agent submitting GPS coordinates on someone's behalf — even ones a person honestly told it — defeats the entire point of the feature; there's no legitimate agent path here, unlike an approval an agent could at least relay. If asked to "check someone in," decline and point at the app.
  - **Compliance (notice/consent to employees before this goes live) is explicitly NOT something this feature handles** — it's a real legal question that varies by state (California in particular has real requirements here) and depends on facts this app has no way to know. The Manage-page card says so directly; don't remove that notice or imply the feature is "done" from a compliance standpoint just because the code works.

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

1. **Get an API key** (once, then reuse it): create one via `POST
   /api/admin/api-keys` with `{ "label": "Hermes" }` (admin-session-gated) —
   the Manage → API Keys card in the UI does the same thing. The raw key
   (`shwrm_<32 chars>`) is returned **once**, in the response body — save
   it; only its hash is kept server-side after that. (`POST
   /api/admin/shift-imports` also still works with an admin session
   instead of a key, for the same all-or-nothing CSV/JSON upload, but
   there's no manual upload form left in the UI for it any more — see §3's
   `day_caps` entry for the parallel Slot Caps removal; use the API
   directly, or have an agent do it.)
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
- Everyone: `me, users (public fields only), shifts, swapPosts, swapClaims, dayCaps, shiftRequests, shiftTemplates, timeOffApproved (everyone's, minimal fields), timeOffMine`.
- Staff-or-above additionally: `timeOffAll, shiftImports, apiKeys (metadata only, never the raw key), passwordResetRequests`.
- Admin additionally: `tiers, userTiers`.

**`shiftTemplates` moved to the "everyone" tier 2026-09-16** (it used to be staff-or-above only) — plain staff now need to read template names/times/days to power the "quick fill" picker on their own availability submission (`schedule.astro`'s `renderEditorTemplatePicker`, same UX as the Schedule Builder's own template picker). There's no actual sensitivity here the way there is for `tiers`, which stays deliberately admin-only-visible.

**`data.me` never carries `email`/`phone`** — see §4's Settings note for why and what to do about it.

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

- **A production deploy silently sits at `readyState: "BLOCKED"` forever (not an error, not a normal queue delay) if the local git commit author's email isn't verified on the GitHub account this Vercel project is connected to.** Real incident, 2026-09-20: another agent (Hermes) had changed this repo's local `git config user.email` while troubleshooting something unrelated, to an address not verified on the connected account — every subsequent commit built from that config got auto-blocked, including ones deployed directly via `vercel --prod --yes` (not just git-push-triggered ones), and retrying the SAME blocked commit repeatedly (as Hermes did, ~10+ times over an hour) never resolves it — it just piles up more blocked deployments. **The API gives no useful signal**: `GET /v13/deployments/:id` returns only `{"readyState":"BLOCKED"}`, no error message, no failed checks. The actual reason only appears in the Vercel **dashboard's** deployment detail page ("Deployment Blocked... commit author email ([x]) is not valid. Ensure your git email matches your GitHub account."). Fix: check `git log -1 --format='%an <%ae>'` against a known-good past deploy's author (`git log <known-good-sha> -1 --format='%an <%ae>'`), reset local config to match (`git config user.email`/`user.name`), then `git commit --amend --reset-author` (or a fresh commit) and `git push --force` before redeploying — a normal, non-authored commit will never go through no matter how many times it's retried.
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
- **Shift Templates management lives ONLY on the Schedule Builder (`admin/schedule.astro`)**, as `<ShiftTemplatesPanel />` — a self-contained component (`src/components/ShiftTemplatesPanel.astro`) built 2026-09-16 to replace Manage's old Slot Caps card (see §3's `day_caps` note). It was briefly also added to Manage (`admin.astro`) the same day, then deliberately pulled back out per the owner's explicit "we only need shift templates under schedule builder" — Manage no longer references it at all. It's fully self-contained regardless of where it's used: fetches its own `shiftTemplates` via `/api/state` and does its own CRUD via `/api/admin/shift-templates`, independent of whichever host page it's dropped into — it does NOT read or write the host page's own `data` object. After any save/delete it dispatches a `window` `"shift-templates-changed"` CustomEvent; `admin/schedule.astro` listens for that to re-run its own `refreshAndRender()` (its calendar/coverage logic reads templates from its own separate `/api/state` polling, so it has no other way to know the component's list changed). If template management is ever needed somewhere else again, drop `<ShiftTemplatesPanel />` in there rather than duplicating the CRUD logic — just confirm with the owner first, since this has already gone back and forth once.
- **When debugging "my change isn't showing up on the live site," check the actual URL first.** `vercel --prod --yes` prints a brand-new, permanently-frozen deployment URL (`https://work-buddy-scheduling-advanced-<random>-the-ray-ally.vercel.app`) every single time — that URL never updates again, no matter how many times it's refreshed or how many later deploys ship. Only `https://work-buddy-scheduling-advanced.vercel.app` (no random suffix) is the stable alias that gets re-pointed to the newest deployment each time. A user reporting a shipped fix "still isn't there" after a hard refresh has, more than once, turned out to be sitting on an old deployment-specific URL from a prior turn's deploy output — always ask for the exact URL in the address bar before assuming the deploy itself failed.

## 10. Verification checklist before calling a change done

1. `npm run build` — catches Astro/type errors immediately.
2. If you touched `src/styles/global.css`: check comment balance (§7).
3. If you touched anything in `src/lib/db/*`: sanity-check the change makes sense against **both** `local.js` and `neon.js` — a partial-update bug in one backend and not the other is exactly how both bugs in §7 shipped.
4. For a UI change: run the dev server, actually click/drag/right-click the feature, check the browser console for errors — don't rely on a clean build alone.
5. For a bulk-import change: hit the endpoint with a real payload (a handful of `shift`/`cap`/`swap` rows) and check `/api/state` reflects it, plus at least one deliberately-bad row to confirm the all-or-nothing validation still rejects cleanly.

## 11. Cloudflare Tunnel + local Hermes bridge (added 2026-09-21; moved to a permanent named tunnel 2026-09-21)

The Vercel-hosted app talks to a local node bridge running on the owner's Mac (`scripts/hermes-bridge.mjs`) over a **named** Cloudflare Tunnel bound to a real domain the owner purchased — not the old random-URL quick tunnel. The owner wanted to use a local LLM API key (their own subscription) instead of paying per-message to a cloud provider. The full plumbing:

- **`scripts/hermes-bridge.mjs`** listens on `127.0.0.1:7890`. POST `/` (or `/chat`) accepts the orchestrator's payload `{ message, history, state, guide }`, logs it to stdout, and writes a stub reply back via the Vercel relay endpoints (`POST /api/admin/agent-chat/reply`). Currently a STUB - the real Hermes session is supposed to replace this with intelligent processing. To swap in real Hermes: replace the body of `processMessage()` with `agent.process(payload)` and write the actual reply content.
  - **A live API key is hardcoded as the fallback default for `AGENT_API_KEY` on this line** (`shwrm_...`) — a real secret committed to source control. This should be revoked and regenerated, with the replacement set only via the Mac's local environment (`AGENT_API_KEY=... node scripts/hermes-bridge.mjs`), never hardcoded again. Flagged, not yet fixed as of this note.
- **`/api/admin/settings/tunnel.js`** stores the tunnel URL in `app_settings` (AES-256-GCM encrypted), GETs return `{ tunnel_url, reachable, mode: 'tunnel'|'cloud'|'offline' }` based on a 2-second `/health` probe, POST validates by probing before saving, DELETE clears it. Works identically regardless of whether the stored URL is a `trycloudflare.com` quick-tunnel URL or a real domain — no code change was needed for the domain move, only the Mac-side tunnel config (below).
- **`/api/admin/settings/chat-source.js`** decides the routing mode (`hermes` / `cloud` / `hybrid` / `offline`). `hybrid` tries tunnel first, falls back to cloud on failure.
- **`/api/agent/chat`** orchestrator reads both settings and dispatches the message accordingly. Cloud mode calls `cloudCfg.provider.chat()` with `messages + system prompt + guide` and parses the ` ```json { actions: [...] } ``` ` block out of the reply text. Tunnel mode POSTs the JSON payload to the tunnel URL and expects `{ content, actions: [] }` back. **Fixed 2026-09-21**: the assistant's chat-bubble text used to be whatever the model wrote in the same completion as its actions block — a prediction written before the actions actually ran, so a failed action (validation error, tier-limit denial, etc.) still showed a confident "Done" to the user, with only a small pass/fail pill as the real signal. Now `orchestrateReply` checks each action's actual `response_status` after execution and overrides the reply text with what actually happened whenever one failed, instead of trusting the model's narration blindly. Also fixed `executeAction()` recomputing its own `origin` from `VERCEL_URL`/`AGENT_SELF_URL` env vars instead of reusing the already-resolved request origin passed into the orchestrator — a second, divergence-prone source of truth for the same value.
- **Fixed 2026-09-21, same day: two more real bugs found via `CHAT_BOT_DEBUG_HANDOFF.md`/`CHAT_BOT_HANDOFF_V2.md`** (Hermes's own diagnostic handoffs — the architecture notes in those files are accurate and worth reading if this area breaks again):
  - **"Problem B" — messages stuck in `pending` forever with no assistant reply ever written.** The POST handler fired `orchestrateReply(...).catch(...)` with no `await` and nothing keeping the serverless function alive afterward — a bare fire-and-forget. Vercel is free to reclaim the function the instant the HTTP response is sent; a fast reply (e.g. "hello", answered by Hermes/cloud in a couple seconds) would finish before reclamation and work, while a slower one (an actual schedule change — tunnel round-trip + local CLI spawn) got killed mid-flight, explaining the exact reported pattern of quick replies working and scheduling requests hanging. Fixed by wrapping the call in `waitUntil()` from `@vercel/functions` (already a dependency, unused until now) in `src/pages/api/agent/chat/index.js`.
  - **"Problem A" — the model narrates a change ("Done — Jorge's on Friday 4-10pm") without emitting the ` ```json {"actions":[...]}``` ` block**, so nothing is actually written even though the reply sounds confident — a ~50% miss rate per Hermes's testing. `orchestrateReply` now retries once, only when `actions.length === 0` AND the user's own message plausibly asked for a real change (regex on action verbs — asking "who's working Thursday" never retries), with an explicit reminder that the block is invisible to the user and required. Only adopts the retry's actions/content if the retry actually produced an action; otherwise keeps the original reply rather than replacing a valid plain-text answer with a worse one.
  - **A THIRD bug found while verifying the above: `main` did not build at all.** `src/layouts/Layout.astro` imported `getChatEnabled` from `src/pages/api/admin/settings/chat-toggle.js`, which never existed as a file — `admin.astro`'s Chat Bot card also called `GET`/`POST /api/admin/settings/chat-toggle` with nothing behind it. Any deploy from `main` in this state would have failed the build outright, not just hit the §7 BLOCKED-deploy gotcha. Added the missing module (same `app_settings`-backed pattern as `chat-source.js`/`tunnel.js`, defaulting to `enabled: true` so the bubble shows without requiring an admin to opt in first). **If a future background-fire-and-forget call is added anywhere in this codebase, it needs the same `waitUntil()` treatment** — this bug class isn't specific to the chat route, it applies to any handler that returns a response before work it started is done.
- **Permanent domain setup (current state).** Cloudflare zone `andshawarmaschedule.com` (zone ID `76b74e6b4f5f3e30e6bf40d155691e1e`), named tunnel id `44210feb-6904-4456-bdd6-1197a1e63d66`, DNS record `@ → 44210feb-6904-4456-bdd6-1197a1e63d66.cfargotunnel.com` (proxied). Chat bot URL: `https://andshawarmaschedule.com`. This is the value that goes into Manage → Settings → Chat Source → Tunnel URL (or `POST /api/admin/settings/tunnel`).
  - `~/.cloudflared/config.yml` on the Mac binds the tunnel id to that hostname and forwards to `http://127.0.0.1:7890` (where the bridge listens).
  - `~/Library/LaunchAgents/com.shawarma.cloudflared.plist` runs `cloudflared tunnel --config ~/.cloudflared/config.yml run` (named-tunnel form), `KeepAlive=true`, restarts on crash/reboot.
  - The old URL-watcher LaunchAgent (`com.shawarma.tunnel-watcher.plist`, which polled for new random `trycloudflare.com` URLs and pushed them to `/api/admin/settings/tunnel`) is **retired/disabled** — a named tunnel's URL never changes, so there's nothing to watch for any more.
  - **`~/.cloudflared/`** holds the tunnel runner (note: `/tmp/cloudflared` is the actual binary, `/usr/local/bin/cloudflared` is a stub). Bridge script lives at `scripts/hermes-bridge.mjs`; bring it up with `cd /Users/testuser/andshawarma-scheduling && { node scripts/hermes-bridge.mjs & } ;`.
- **Why this moved off the quick tunnel**: `cloudflared tunnel --url` gives a random `https://<random>.trycloudflare.com` URL that changes on every restart, requiring the watcher LaunchAgent as a workaround. A named tunnel bound to a real domain (`cloudflared tunnel create` + `cloudflared tunnel route dns`) has a URL that survives restarts/reboots indefinitely, which is what "a fluid chat bot experience" for end users needs — no risk of the tunnel URL going stale between the watcher's 10s polls.
- **A local Mac checkout can silently diverge from `origin/main` and deploy stale/reverted code even though GitHub is correct — verify against `origin/main` directly before re-patching anything reported broken.** Real incident, 2026-09-21: a diagnostic report (`CHAT_BOT_DIAGNOSTIC_FOR_CLAUDE.md`) claimed the narration-override fix from commit `0ee47e9` had been clobbered by a later merge, based on a `grep` that found nothing in the local file. It was wrong — the code was, and is, present and correctly ordered on `origin/main`. The local Mac checkout had a merge commit (`84969ed`, referencing `git checkout --theirs CLAUDE.md src/pages/api/agent/chat/index.js` during a stash-drop) that doesn't exist anywhere on `origin/main`, and its file excerpt showed code (a "security check" block, an early-return for empty `assistantText`) that was never committed to this repo at all. **Whenever a "my fix disappeared" report comes in, `git fetch` + check the file on `origin/main` directly before assuming the hosted code is wrong** — the actual bug may be a diverged/corrupted local checkout that needs `git reset --hard origin/main`, not a new patch.
- **`scripts/hermes-bridge.mjs`'s prompt-builder used to claim "today is in the prompt context" (§4b) without ever actually including it** — the model had no real anchor for "today"/"this month" and was guessing from the few-shot examples' hardcoded illustration dates, which is why "add me to every Saturday this month" produced only 1 of 4 matching Saturdays with an invented (never-requested) time. Fixed 2026-09-21: `buildPrompt()` now injects an explicit `TODAY'S DATE: YYYY-MM-DD (Weekday)` line computed server-side (never trusted from the client), and §4b points at it instead of the stale examples. Also fixed a dead-code bug in the same file found while in there: the DEBUG prompt-write block referenced `prompt` before its `const` declaration — threw a `ReferenceError` on every single request, silently swallowed by the same `try/catch` block it was in, so the debug file was never actually written. Moved `buildPrompt()` above it.

## 12. Chat attachments (photos + PDFs + text docs; added 2026-09-21)

The chat bot lets staff and managers send **photos**, **PDFs**, and **text/doc documents** (no audio, no video, no spreadsheets - owner confirmed this scope). All UI uses inline SVGs, no emoji. Drag-drop on desktop, native camera (`capture="environment"`) on mobile, paperclip button opens the file picker.

- **Schema.** `agent_chat_attachments` table: `id, message_id (FK->agent_chat_messages), user_id, filename, mime_type, byte_size, storage_path, created_at`. Indexed on `message_id` and `user_id`.
- **Storage.** Files written to `os.tmpdir()/chat-uploads/<uuid>__<safe-filename>` - the server's local `/tmp`. On Vercel this is tmpfs: survives within a single warm instance but NOT across cold starts. The GET endpoint returns `410 Gone` if the file vanished so the UI shows a clean "file no longer available" chip instead of a stack trace. For long-lived storage, move to Cloudflare R2 (free 10GB egress/month on the same account).
- **Upload endpoint** (`POST /api/agent/chat/upload`). Multipart form-data, field name `file`. Optional `message_id` to attach directly to an existing message; otherwise creates a placeholder user-message row so the FK is satisfied, then the chat POST re-links the attachment to the real message. Max 10 MB per file (matches Cloudflare tunnel free-tier body cap).
- **Serve endpoint** (`GET /api/agent/chat/attachments/[id]`). Streams the file from disk. Auth: uploader OR any admin/manager. Sets `Content-Disposition: inline` for browser preview + click-to-download.
- **Chat POST** (`/api/agent/chat`). Accepts either JSON `{ content, attachment_ids? }` or multipart. When attachments are linked, the orchestrator's payload to the agent now includes `message.attachments = [{ id, filename, mime_type, byte_size, storage_path, base64 }]`. Files ≤2 MB get the base64 inlined; larger files send metadata only (cloud provider can't reach server tmpfs, so it tells the user the file is too large to inline-attach).
- **UI** (`src/components/AgentChatPanel.astro`). All icons are inline SVGs (Feather Icons-style) - no emoji. Paperclip button on the textarea opens the file picker (`accept="image/*,application/pdf,text/*,.doc,.docx,.txt"`, `capture="environment"`, `multiple`). Drag-drop on the chat panel highlights with a dashed outline. Pending uploads show as chips above the textarea with a remove × button. Sent messages render image MIME types as inline thumbnails (click -> full size in new tab), everything else as file chips with SVG icon + filename + size.

## 13. Deployment topology - current (corrected 2026-09-21)

The repo is pushed to **one** GitHub repo (`andshawarmaai/andshawarmaschedulingapp`, remote `origin`), deploying to **one** Vercel project (`andshawarmaschedulingapp`, id `prj_myeSrvOqeHDVKRTuZNm7UdpWPHw6`), with **one** Neon database. Live URL: `https://andshawarmaschedulingapp.vercel.app`.

The earlier "two repos / two Vercel projects / two Neon databases" model documented in §2 of this file is **stale and incorrect**. The orphan `therayally/andshawarmatest` remote will 403 on push (the GitHub account `andshawarmaai` lacks write access), so do NOT `git push customer`. Push to `origin` only.

Deploy command:
```bash
cd /Users/testuser/andshawarma-scheduling && /Users/testuser/.local/node_modules/.bin/vercel deploy --prod --yes --token "$VERCEL_TOKEN"
```
