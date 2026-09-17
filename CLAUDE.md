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
- **`day_caps`** — a one-off exception on a single date/window (`date, window_start, window_end, max_shifts, note`), separate from the recurring `shift_templates`. **The "Slot Caps" Manage-page UI for creating/clearing these was removed 2026-09-16** (the owner found it redundant with Shift Templates, which already covers "how many people, what times") — the data model, `/api/admin/day-caps`, and `type=cap` bulk-import rows are all still fully functional, there's just no manual form for it any more. Create one via a bulk import or have an agent do it if it's ever needed again.
- **`api_keys`** — programmatic access for an external agent (see §5). `label, key_prefix, key_hash, created_by, last_used_at, revoked`. The raw key is shown exactly once at creation.
- **`password_reset_requests`** — there's no email sender; "Forgot password?" files a row here for an admin to see and resolve manually.

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
- **Day view has a "coverage" panel above the timeline**: one card per shift template that applies to that date, colored red if under its `min_staff`, green ("Fully staffed") if it meets/exceeds it, amber if it exceeds `max_staff`, or neutral if the template has no min set — plus a row of draggable staff-name chips underneath. The big number reads as "X of Y" (against `min_staff`, or `max_staff` once over it) rather than a bare count, since a bare "0" means nothing without also reading the min/max line above it. Dragging a name onto a card creates a shift for that exact template's date/start/end (`POST /api/shifts`); clicking a card (no drag) opens the same Add Shift modal instead, prefilled with that block's time, for admins who'd rather not drag. Point being: an admin shouldn't have to mentally cross-reference a pile of individual chips against the Shift Templates list to tell whether a day is actually fully staffed — every card should read green, like finishing a puzzle. Computed by `computeDayCoverage()` in `client/coverage.js`, using the exact same best-fit template attribution as the conflict flags above, so the two always agree.
- **Coverage checking is instant-by-instant, not a single daily total.** `computeDayCoverage`/`computeTemplateTimeGaps` (`client/coverage.js`) sweep a template's window and split it into sub-intervals wherever the concurrent headcount changes (`sweepTemplateCoverage`) — deliberately ANY-OVERLAP matching, not the strict best-fit containment `computeShiftRequestConflicts` uses (that one's answering "which named role is this shift," this one's answering "is this window covered right now"). A shift that starts an hour early or ends an hour late still provides real coverage during the part that overlaps, and a shift that's simply time-shifted must not read as a wide-open slot. The coverage panel's "X of Y" reports the WORST moment in the window when there's a `min_staff` (so "fully staffed 9-5 but empty the last hour" correctly shows as short), and the PEAK moment for `over`/`neutral`.
- **The Day view timeline itself also shows open slots, not just the summary cards above it**: positioned at their precise time-of-day and packed into the SAME overlap-column layout as real shift bars (`computeGhostItems`/`coverageGapBarHtml`/`dayBarsHtml` in `admin/schedule.astro`) — never a background band that real bars could fully cover. Each open slot is its own drag target/click target exactly like a coverage-panel card. Week view deliberately doesn't get these (`dayBarsHtml`'s `ghostItems` param is Day-view-only) — the narrower week columns would get too cluttered.
  - **`computeGhostItems` locks every ghost lane's box to the template's own FULL declared window (`start_time`-`end_time`) — it never resizes to some shorter, currently-uncovered sub-range.** This went through two earlier designs before landing here, both real, both fixed 2026-09-16 same day: (1) one ghost item per gap SEGMENT — a request overlapping just PART of a template's window split it into segments with different needed-counts each side, so the same logical "slot" could land in a different column before/after the split, fragmenting into stacked/misaligned pieces; (2) fixed that by giving each lane a stable column but still sizing its BOX to only the exact currently-short sub-range (accurate, but the box would visibly resize/reshape every time an unrelated shift moved elsewhere in the day, since any-overlap coverage from that shift could cover/uncover part of ANY template's window) — the owner explicitly rejected this after watching it happen: "you need to lock in the size of the shift templates... they just keep resizing." Final fix: for lane `i`, if `segments.some(s => s.needed > i)` (short SOMEWHERE in the window), push exactly one ghost spanning the template's full `toMinutes(start_time)`-`toMinutes(end_time)` range (with the usual `end <= start` midnight-wrap) — never a partial run. A lane can still appear or disappear entirely as coverage changes elsewhere (that's still correct — "Needs 2 more" becoming "Needs 3 more" is real information), but once shown, its box's position and size are 100% a function of the template's own definition, never of what else happens to be scheduled that day.
  - **Day view uses a separate, never-reuse packer (`packNoReuse`), NOT `packOverlaps` — Week view is the only caller of `packOverlaps` now.** `packOverlaps` frees a column the moment its occupant's `end` has passed, so a later, unrelated item can take that same x-position — exactly right for Week view, where 7 already-narrow day columns can't afford one lane per item, but in Day view it reads as one thing "stacking" underneath another even though the two never actually overlap in time (a real, explicitly-rejected-by-the-owner behavior, fixed 2026-09-16: "I don't want any column sitting on the bottom, I want them all left to right"). `packNoReuse` sorts by `(start, end)` same as `packOverlaps`, but assigns `col = index in that sorted order` and never frees/reuses a column — every real shift, pending request, and ghost open slot in a day gets its own permanent lane for the whole day. `dayBarsHtml`'s new `noReuse` boolean param picks the packer and switches its bars' `left`/`width` from Week's percentage split to a fixed `DAY_COL_WIDTH_REM` (7.5rem) per lane; `barHtml`/`coverageGapBarHtml` take pre-formatted `leftCss`/`widthCss` strings now (e.g. `"37.5%"` or `"15rem"`) instead of bare percentage numbers, so either caller can plug in its own unit. The container (`.cal-day-body`, Day-view-only — Week uses `.cal-week-body`/`.cal-week-days` instead) gets `overflow-x:auto` plus a `minmax(0, 1fr)` second grid track so it doesn't just auto-grow to fit the wide `.cal-day-col`, and `renderDay()` sets that column's explicit `width`/`min-width` to `cols * DAY_COL_WIDTH_REM`rem (the `cols` count now comes back from `dayBarsHtml`, which returns `{ html, cols }` rather than a bare string). Net effect: narrow, non-negotiable per-item columns, with horizontal scrolling picking up the slack instead of ever reusing a lane — both explicitly accepted by the owner over a more compact layout.
  - **Day view also uses a much shorter vertical scale than Week — `DAY_REM_PER_HOUR` (1rem/hour) vs Week's `REM_PER_HOUR` (2.5rem/hour)** — fixed 2026-09-16 after the taller scale meant a business whose hours ran past midnight needed real vertical scrolling to see the whole day, which the owner explicitly didn't want ("I should see it all in one window view... even if the numbers are stacked on top of each other"). Only `renderDay()`'s `.cal-day-col` height uses the shorter constant; Week is untouched (`renderWeek()` still uses `REM_PER_HOUR`) since it has more room to work with and wasn't part of the complaint. At this tighter scale a genuinely brief bar/gap could shrink to an unreadable sliver, so Day-view-only bars/gaps get a `min-height` floor (`.cal-day-body .req-bar`/`.shift-bar`/`.coverage-gap` — `.cal-day-body` is Day-view-only, Week's `.cal-day-col` instances live under `.cal-week-days` instead).
    - **That floor must actually be tall enough to fit its own text content, or `overflow:hidden` silently clips the BOTTOM of the letters instead of leaving room for them** — a real regression, fixed 2026-09-16, caught from a live report that looked exactly like the earlier no-reuse packing bug returning ("a compressed column... I don't remember that being a shift time"), but wasn't a positioning bug at all: `getBoundingClientRect()` confirmed the boxes were correctly side-by-side with zero overlap, it was purely that a 0.6875rem/~16.5px line of text plus the element's own vertical padding needed more room than the 1.125rem the floor first shipped at, so the bottom ~4-5px of every letter was sliced off — which reads as garbled/strikethrough text, easy to mistake for two boxes colliding. Fixed with content-appropriate, per-element-type minimums: `.coverage-gap` (one line of text) gets `1.75rem`; `.req-bar`/`.shift-bar` (TWO stacked lines — who/when) need more and get `2.5rem`. **If this floor is ever changed again, verify with `getBoundingClientRect()` that the text's own bottom edge is `<=` the container's bottom edge — don't just eyeball a screenshot, this exact bug looks identical to an actual layout collision at a glance.**
  - **A coverage-gap block's label/tooltip now states its OWN start–end time, not just the template's name** (`coverageGapBarHtml`, fixed 2026-09-16) — a template can be covered for most of its window by a shift that overlaps it (any-overlap, not best-fit — see below) and genuinely short by only a small remaining sub-range, which used to look like a rendering glitch ("a very short column... should stretch the span of where it goes up to") with nothing on the block explaining why. It's not a bug: `computeTemplateTimeGaps` already only reports the actual uncovered sub-interval, and now the block says so (`"Template Name · 9:00 AM–11:30 AM"`, not just the template's name) — **as ONE line, not two stacked spans**: an earlier version split the name and time onto separate lines, which visibly overlapped into illegible garbage on a genuinely short block (Day view's tighter `DAY_REM_PER_HOUR` scale leaves barely room for one line, let alone two) — a single ellipsis-truncated line just clips cleanly instead, and the full text is still in the `title` tooltip.
  - **Dragging an ALREADY-APPROVED shift bar onto a coverage-block/coverage-gap now opens the Edit Shift modal (prefilled with the block's date/time), instead of silently doing nothing** (`wireCoverageInteractions`'s drop handler, fixed 2026-09-16 — "I try to drag David out of the approved shift... it would not let me do it"). Root cause: `.shift-bar`'s `dragstart` (wired by the generic `wireDragDrop`, shared with Month/Week's cross-DATE move) sets `application/x-kind: 'shift-approved'`, but the coverage-block/gap drop handler only ever branched on `'roster-user'`/`'shift-pending'` — so an approved-shift drop fell through to nothing there, then BUBBLED UP to `wireDragDrop`'s own day-column drop handler, which moves a shift to a different DATE and silently no-ops when `shift.date === targetDate` (always true in Day view, since there's only one date on screen). Fixed by (a) adding a `stopPropagation()` at the top of the coverage-block/gap drop handler so it no longer falls through to the date-move handler, and (b) a new branch for `kind === 'shift-approved'` that calls `openEditShiftModal(shiftId, overrideDate, overrideStart, overrideEnd)` — a new 3-arg form of the existing edit-modal opener that prefills from the DROP TARGET's time instead of the shift's current one. Nothing is written until the admin hits Save (same reviewable-before-committing pattern as every other drop onto a coverage block) — the actual coverage math (including any leftover red on partial coverage) just falls out of the normal any-overlap sweep once saved, no special-casing needed.
  - **Dragging an approved shift onto BLANK Day-view timeline space (not onto a coverage-block/gap) now also opens the Edit modal, with a new time computed from where it was dropped** — `wireDayTimeDrag` in `admin/schedule.astro`, fixed 2026-09-16 ("I wanna be able to un-commit him from one of the shift templates... snapping and un-snapping"). Before this, dropping a shift bar on empty timeline area only hit `wireDragDrop`'s generic same-date no-op (see above) — there was no way to "pull" a shift off whatever block it currently overlaps and reposition it freely. The new handler reads the drop's Y offset within `.cal-day-col`, converts it to a raw minute value (`startMin + fraction * windowMin`), snaps to the nearest 15 minutes, and opens `openEditShiftModal` with that as the new start time — the shift's original DURATION is preserved (only when it starts moves, not how long it runs), and `minutesToHHMM`'s existing mod-1440 normalization plus a same `addDays` day-bump as `computeGhostItems` handles a drop that lands past midnight. Nothing commits until Save, same as every other drag onto this calendar.
  - **A coverage-gap block's label puts its own time range FIRST, template name second** (`coverageGapBarHtml`) — since the box's size is now locked to the template's own window (see above), `gapStart`/`gapEnd` are always just that template's `start_time`/`end_time` restated, so this ordering is no longer masking a mismatch the way it originally did — it's kept mainly for narrow-column truncation safety (the template name, e.g. "9am to 9:30pm — Closer", is the part more likely to run long and get ellipsis-cut).
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
- **When debugging "my change isn't showing up on the live site," check the actual URL first.** `vercel --prod --yes` prints a brand-new, permanently-frozen deployment URL (`https://andshawarmatest-<random>-the-ray-ally.vercel.app`) every single time — that URL never updates again, no matter how many times it's refreshed or how many later deploys ship. Only `https://andshawarmatest.vercel.app` (no random suffix) is the stable alias that gets re-pointed to the newest deployment each time. A user reporting a shipped fix "still isn't there" after a hard refresh has, more than once, turned out to be sitting on an old deployment-specific URL from a prior turn's deploy output — always ask for the exact URL in the address bar before assuming the deploy itself failed.

## 10. Verification checklist before calling a change done

1. `npm run build` — catches Astro/type errors immediately.
2. If you touched `src/styles/global.css`: check comment balance (§7).
3. If you touched anything in `src/lib/db/*`: sanity-check the change makes sense against **both** `local.js` and `neon.js` — a partial-update bug in one backend and not the other is exactly how both bugs in §7 shipped.
4. For a UI change: run the dev server, actually click/drag/right-click the feature, check the browser console for errors — don't rely on a clean build alone.
5. For a bulk-import change: hit the endpoint with a real payload (a handful of `shift`/`cap`/`swap` rows) and check `/api/state` reflects it, plus at least one deliberately-bad row to confirm the all-or-nothing validation still rejects cleanly.
