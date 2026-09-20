// Client-side mirror of src/lib/coverage.js's overlap math, used only for
// calendar rendering (never for writes) — the server is still the one
// source of truth for anything that persists. Kept separate from
// coverage.js rather than shared, since that module takes a `db` and
// this one operates on arrays the page already has from /api/state,
// matching the existing split between format.js's slotStatus/isBlocked
// (client, array-based) and their server equivalents.

function toMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function templateRange(template) {
  const start = toMinutes(template.start_time);
  let end = toMinutes(template.end_time);
  if (end <= start) end += 24 * 60;
  return [start, end];
}

function rowRange(row) {
  const start = toMinutes(row.start_time);
  let end = toMinutes(row.end_time);
  if (end <= start) end += 24 * 60;
  return [start, end];
}

// Fully contained within the template's window, not just any overlap — a
// distinctly-shaped shift that merely touches part of a template's hours
// (e.g. an 11:30-10:30 shift brushing a 9-6 template) isn't a request for
// THAT block and shouldn't count toward its max_staff. See the matching
// note in ../coverage.js, which this mirrors for calendar rendering.
function fits(row, template) {
  const [tStart, tEnd] = templateRange(template);
  const [rStart, rEnd] = rowRange(row);
  return rStart >= tStart && rEnd <= tEnd;
}

export function dayOfWeek(dateStr) {
  return new Date(`${dateStr}T00:00:00`).getDay();
}

function templatesForDate(templates, dateStr) {
  const dow = String(dayOfWeek(dateStr));
  return templates.filter((t) => t.days_of_week.split(',').map((d) => d.trim()).includes(dow));
}

function addDaysISO(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

// A template's window can run past midnight (e.g. a closer block ending
// 2:30am), and filling the tail of that window has to be dated the NEXT
// calendar day for calendar accuracy (see computeGhostItems's date-bump in
// admin/schedule.astro) — a shift genuinely starting at 1:30am happens
// tomorrow, not today. But that means the shift meant to cover today's
// overnight tail is dated tomorrow, so it has to be pulled back in here,
// shifted +24h, or filling that gap would never make the red block clear.
//
// Deliberately APPROVED SHIFTS ONLY — a pending request must never count
// toward closing a gap on its own (a real, reported bug fixed 2026-09-16:
// submitting an availability request made its own open slot shrink/vanish
// with no admin action at all, reading as if the app had silently
// auto-assigned it). Multiple people can be pending for the same slot at
// once and the admin needs to see the gap stay fully open until they
// actually pick one and approve it — the pending bar itself still renders
// on the timeline (dayBarsHtml includes it separately), it just doesn't
// feed this sweep. `computeShiftRequestConflicts` below is unrelated and
// keeps combining pending+approved on purpose — that one flags "too many
// people, decided or not," which is a different question from "is this
// window actually staffed yet."
function rowsForSweep(shifts, shiftRequests, dateStr) {
  const tomorrow = addDaysISO(dateStr, 1);
  const sameDay = shifts.filter((s) => s.date === dateStr);
  const nextDay = shifts.filter((s) => s.date === tomorrow);
  return [
    ...sameDay.map((row) => rowRange(row)),
    ...nextDay.map((row) => { const [s, e] = rowRange(row); return [s + 24 * 60, e + 24 * 60]; }),
  ];
}

// A restaurant's templates routinely nest — e.g. "1 Opener, 9am-9:30pm"
// and "3 Mid AM, 9am-6pm" both legitimately run at once, and every Mid AM
// shift also technically *fits inside* the wider Opener window. Attributing
// a shift to every template it merely fits inside (the old behavior) meant
// those 3 Mid AM people also got counted against the 1-person Opener cap —
// a false conflict on a perfectly normal schedule. A shift instead belongs
// to whichever containing template is the tightest (smallest) fit — the
// most specific rule actually describing that slot — never more than one.
function bestFitTemplate(templatesForThisDate, row) {
  let best = null;
  let bestDuration = Infinity;
  for (const template of templatesForThisDate) {
    if (!fits(row, template)) continue;
    const [tStart, tEnd] = templateRange(template);
    const duration = tEnd - tStart;
    if (duration < bestDuration) {
      bestDuration = duration;
      best = template;
    }
  }
  return best;
}

// Returns a Map<id, string> keyed by BOTH pending 'create' shift-request ids
// and, now that admins can drag/drop already-scheduled shifts on the same
// calendar, approved shift ids too — the conflict detail for anything that,
// combined with everything else assigned to the same date+template slot,
// would exceed that template's max_staff. Requests/shifts matching no
// template (a custom time outside any defined block) are never flagged —
// there's no rule to check them against. Keys never collide since shift ids
// and shift-request ids are drawn from separate uuid columns.
export function computeShiftRequestConflicts(shiftTemplates, shifts, shiftRequests) {
  const conflicts = new Map();
  const pendingCreates = shiftRequests.filter((r) => r.status === 'pending' && r.action === 'create');
  const dates = [...new Set([...pendingCreates.map((r) => r.date), ...shifts.map((s) => s.date)])];

  for (const date of dates) {
    const templates = templatesForDate(shiftTemplates, date);
    if (templates.length === 0) continue;

    // Assign every shift/request on this date to its single best-fit
    // template (or none) before checking anyone's cap.
    const byTemplate = new Map(); // template -> { committed: [], pending: [] }
    for (const s of shifts) {
      if (s.date !== date) continue;
      const template = bestFitTemplate(templates, s);
      if (!template) continue;
      if (!byTemplate.has(template)) byTemplate.set(template, { committed: [], pending: [] });
      byTemplate.get(template).committed.push(s);
    }
    for (const r of pendingCreates) {
      if (r.date !== date) continue;
      const template = bestFitTemplate(templates, r);
      if (!template) continue;
      if (!byTemplate.has(template)) byTemplate.set(template, { committed: [], pending: [] });
      byTemplate.get(template).pending.push(r);
    }

    for (const [template, { committed, pending }] of byTemplate) {
      if (template.max_staff == null) continue;
      const total = committed.length + pending.length;
      if (total > template.max_staff) {
        const note = `${total} scheduled for "${template.name}" (${template.start_time}–${template.end_time}) — only ${template.max_staff} allowed at once.`;
        for (const r of pending) conflicts.set(r.id, note);
        for (const s of committed) conflicts.set(s.id, note);
      }
    }
  }
  return conflicts;
}

// One row per template that applies to `dateStr`. Powers the Schedule
// Builder's Day view "coverage" panel — a plain-English, at-a-glance
// answer to "is today's schedule actually filled in" instead of making an
// admin infer it from a pile of individual chips.
//
// Best-fit containment ONLY (same rule as groupDayItemsByTemplate/
// computeShiftRequestConflicts) — a shift counts toward exactly one
// template's numbers, never both. This used to be deliberately ANY-
// OVERLAP instead (a shift merely touching a template's window counted
// toward it too, on the theory that overlapping coverage is still real
// coverage), but that meant two genuinely independent, merely-adjacent-
// or-overlapping templates could each show the SAME people counted
// against them — e.g. a 9am-6pm shift inflating a completely separate
// 10:30am-9:30pm template's headcount to "2 of 1, over capacity" with
// zero shifts actually assigned to it. Real, reported confusion: "these
// are independent shifts so they have nothing to do with each other...
// one shift template does not pull math or people from another shift
// template." Matching the timeline's own grouping means the panel and
// the timeline below it can never disagree about the same day again.
//
// Only APPROVED shifts count — same "a pending request must never count
// toward closing a gap on its own" rule groupDayItemsByTemplate follows,
// so this can't disagree with the timeline about that either.
export function computeDayCoverage(shiftTemplates, shifts, shiftRequests, dateStr) {
  const { groups } = groupDayItemsByTemplate(shiftTemplates, shifts, [], dateStr);
  return groups.map(({ template, approved }) => {
    const count = approved.length;
    const overMax = template.max_staff != null && count > template.max_staff;
    const underMin = template.min_staff != null && count < template.min_staff;
    const status = overMax ? 'over' : underMin ? 'under' : template.min_staff != null ? 'filled' : 'neutral';
    return { template, count, status };
  });
}

// One entry per template that applies to `dateStr` and either has a
// min_staff/max_staff rule to track or has at least one person already on
// it — a template with neither is invisible here, same as it already is
// on the coverage panel. Every approved shift and pending (status=pending,
// action=create) request is grouped under its single best-fit template
// (same best-fit rule as computeShiftRequestConflicts above); anything
// that fits no template at all comes back separately as `unmatched`.
//
// Replaces the old sub-range gap-tracking (computeTemplateTimeGaps +
// admin/schedule.astro's computeGhostItems) for the Day view timeline —
// that model gave a template needing 3 people up to 3 separate columns
// (one lane per still-open head), which is exactly the "three columns for
// the same 9-9 block" compression the owner asked to fix: "we'll stop all
// the compression that happens in the adding of co[lumns]... one column
// and we'll have [N] slots inside that column." This groups by template
// instead, so the caller renders ONE column per template, sized to the
// template's own declared time window ("the column size stay in place
// based on the timeframe it covers"), with one row per person inside it —
// filled (approved), unapproved (pending, awaiting a decision), or empty
// (still needs someone). The coverage PANEL above the timeline (see
// computeDayCoverage) is unrelated and unchanged — this only reshapes the
// timeline underneath it.
export function groupDayItemsByTemplate(shiftTemplates, shifts, shiftRequests, dateStr) {
  const templates = templatesForDate(shiftTemplates, dateStr);
  const byTemplate = new Map(); // template -> { approved: [], pending: [] }
  const unmatched = [];

  for (const s of shifts) {
    if (s.date !== dateStr) continue;
    const template = bestFitTemplate(templates, s);
    if (!template) { unmatched.push({ kind: 'shift-approved', row: s }); continue; }
    if (!byTemplate.has(template)) byTemplate.set(template, { approved: [], pending: [] });
    byTemplate.get(template).approved.push(s);
  }
  for (const r of shiftRequests) {
    if (r.date !== dateStr) continue;
    const template = bestFitTemplate(templates, r);
    if (!template) { unmatched.push({ kind: 'shift-pending', row: r }); continue; }
    if (!byTemplate.has(template)) byTemplate.set(template, { approved: [], pending: [] });
    byTemplate.get(template).pending.push(r);
  }

  const groups = [];
  for (const template of templates) {
    const bucket = byTemplate.get(template) || { approved: [], pending: [] };
    const hasRule = template.min_staff != null || template.max_staff != null;
    const hasPeople = bucket.approved.length > 0 || bucket.pending.length > 0;
    if (!hasRule && !hasPeople) continue;
    groups.push({ template, approved: bucket.approved, pending: bucket.pending });
  }
  return { groups, unmatched };
}
