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
function overlaps(row, template) {
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

// Returns a Map<shiftRequestId, string> — the conflict detail for every
// pending 'create' shift request that, combined with existing shifts and
// every other pending request for the same date+template window, would
// exceed that template's max_staff. Requests matching no template (a
// custom time outside any defined block) are never flagged — there's no
// rule to check them against.
export function computeShiftRequestConflicts(shiftTemplates, shifts, shiftRequests) {
  const conflicts = new Map();
  const pendingCreates = shiftRequests.filter((r) => r.status === 'pending' && r.action === 'create');
  const dates = [...new Set(pendingCreates.map((r) => r.date))];

  for (const date of dates) {
    for (const template of templatesForDate(shiftTemplates, date)) {
      if (template.max_staff == null) continue;
      const committed = shifts.filter((s) => s.date === date && overlaps(s, template));
      const pending = pendingCreates.filter((r) => r.date === date && overlaps(r, template));
      const total = committed.length + pending.length;
      if (total > template.max_staff) {
        for (const r of pending) {
          conflicts.set(r.id, `${total} requested/scheduled for "${template.name}" — only ${template.max_staff} allowed.`);
        }
      }
    }
  }
  return conflicts;
}
