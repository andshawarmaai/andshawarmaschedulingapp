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

// How many people are actually present, instant-by-instant, across a
// template's window — deliberately ANY-OVERLAP here, not the strict
// best-fit containment computeShiftRequestConflicts uses. That function is
// answering "which named role does this shift represent" (so a nested
// template's headcount isn't double-counted); this one is answering "is
// this window covered at all, and by how many people, right now" — a
// shift that starts an hour early or ends an hour late relative to the
// template's declared time is still real, physical coverage during the
// part that overlaps, and has to count or a merely time-shifted shift
// would look like a totally open slot it isn't. Splits the window into
// the minimal set of sub-intervals where the concurrent count doesn't
// change, so a partial gap (e.g. the last hour of a closer block nobody
// covers) is found precisely instead of only as a daily total.
function sweepTemplateCoverage(template, ranges) {
  const [tStart, tEnd] = templateRange(template);
  const overlapping = ranges
    .filter(([s, e]) => s < tEnd && e > tStart)
    .map(([s, e]) => [Math.max(s, tStart), Math.min(e, tEnd)]);

  const points = [...new Set([tStart, tEnd, ...overlapping.flat()])].sort((a, b) => a - b);
  const segments = [];
  for (let i = 0; i < points.length - 1; i++) {
    const start = points[i];
    const end = points[i + 1];
    if (end <= start) continue;
    const count = overlapping.filter(([s, e]) => s <= start && e >= end).length;
    segments.push({ start, end, count });
  }
  return segments.length ? segments : [{ start: tStart, end: tEnd, count: 0 }];
}

// One row per template that applies to `dateStr`. Powers the Schedule
// Builder's Day view "coverage" panel — a plain-English, at-a-glance
// answer to "is today's schedule actually filled in" instead of making an
// admin infer it from a pile of individual chips. The displayed count is
// the WORST moment in the window (its minimum concurrent headcount) when
// there's a min_staff to judge against — a template that's fully staffed
// 9-5 but drops to zero for the last hour is not "fully staffed", and a
// single daily total would hide exactly that. `over` instead looks at the
// PEAK moment, since exceeding max_staff even briefly is the problem.
export function computeDayCoverage(shiftTemplates, shifts, shiftRequests, dateStr) {
  const templates = templatesForDate(shiftTemplates, dateStr);
  const ranges = rowsForSweep(shifts, shiftRequests, dateStr);

  return templates.map((template) => {
    const segments = sweepTemplateCoverage(template, ranges);
    const counts = segments.map((s) => s.count);
    const minCount = Math.min(...counts);
    const maxCount = Math.max(...counts);
    const overMax = template.max_staff != null && maxCount > template.max_staff;
    const underMin = template.min_staff != null && minCount < template.min_staff;
    const status = overMax ? 'over' : underMin ? 'under' : template.min_staff != null ? 'filled' : 'neutral';
    const count = status === 'over' || status === 'neutral' ? maxCount : minCount;
    return { template, count, status };
  });
}

// The actual sub-intervals of each date-applicable template's window that
// aren't covered by enough people at that exact moment — not just "the
// daily headcount is short," but "which specific hours are short" (see
// sweepTemplateCoverage). Each returned gap is one contiguous segment plus
// how many more people it's short by; a segment needing 2 more should
// become two separate fillable slots, not one, hence `needed` rather than
// a single flat "understaffed" flag. Powers the Day view timeline's open-
// slot blocks (see computeGhostItems in admin/schedule.astro).
export function computeTemplateTimeGaps(shiftTemplates, shifts, shiftRequests, dateStr) {
  const templates = templatesForDate(shiftTemplates, dateStr);
  const ranges = rowsForSweep(shifts, shiftRequests, dateStr);

  const gaps = [];
  for (const template of templates) {
    if (template.min_staff == null) continue;
    for (const { start, end, count } of sweepTemplateCoverage(template, ranges)) {
      if (count < template.min_staff) gaps.push({ template, start, end, needed: template.min_staff - count });
    }
  }
  return gaps;
}
