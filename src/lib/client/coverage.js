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

// One row per template that applies to `dateStr`, with how many people are
// currently assigned to it (using the same best-fit attribution as
// computeShiftRequestConflicts, so this agrees with the conflict flags
// rather than a separately-computed number). Powers the Schedule Builder's
// Day view "coverage" panel — a plain-English, at-a-glance answer to "is
// today's schedule actually filled in" instead of making an admin infer it
// from a pile of individual chips.
export function computeDayCoverage(shiftTemplates, shifts, shiftRequests, dateStr) {
  const templates = templatesForDate(shiftTemplates, dateStr);
  const dayShifts = shifts.filter((s) => s.date === dateStr);
  const pendingCreates = shiftRequests.filter((r) => r.status === 'pending' && r.action === 'create' && r.date === dateStr);

  const counts = new Map(); // template -> count
  for (const row of [...dayShifts, ...pendingCreates]) {
    const template = bestFitTemplate(templates, row);
    if (!template) continue;
    counts.set(template, (counts.get(template) || 0) + 1);
  }

  return templates.map((template) => {
    const count = counts.get(template) || 0;
    const overMax = template.max_staff != null && count > template.max_staff;
    const underMin = template.min_staff != null && count < template.min_staff;
    const status = overMax ? 'over' : underMin ? 'under' : template.min_staff != null ? 'filled' : 'neutral';
    return { template, count, status };
  });
}
