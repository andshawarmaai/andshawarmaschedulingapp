// Computes a non-blocking staffing warning when a request would remove
// someone from a shift covered by a recurring shift_template's minimum
// (see db/schema.sql). Unlike tierLimits.js, this never denies anything —
// it only attaches a human-readable heads-up to a request that still goes
// to Pending Approvals as normal, so whoever decides can see the tradeoff.

export function toMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

// "21:00" -> "9:00 PM" (so the warning reads naturally to a manager)
function format12(hhmm) {
  if (!hhmm) return '';
  const [h, m] = hhmm.split(':').map(Number);
  const period = h >= 12 ? 'PM' : 'AM';
  const hour12 = ((h + 11) % 12) + 1;
  return `${hour12}:${String(m).padStart(2, '0')} ${period}`;
}

// "2026-09-24" -> "Thursday, September 24"
function formatFriendlyDate(dateStr) {
  if (!dateStr) return '';
  const [y, mo, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, mo - 1, d);
  return dt.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
}

// End-exclusive minute range for `template` as it applies to the specific
// calendar date it *starts* on. end can exceed 1440 when the block
// crosses midnight (e.g. 16:30-02:30 => [990, 1590)).
export function templateRange(template) {
  const start = toMinutes(template.start_time);
  let end = toMinutes(template.end_time);
  if (end <= start) end += 24 * 60;
  return [start, end];
}

export function shiftRange(shift) {
  const start = toMinutes(shift.start_time);
  let end = toMinutes(shift.end_time);
  if (end <= start) end += 24 * 60;
  return [start, end];
}

export function dayOfWeek(dateStr) {
  return new Date(`${dateStr}T00:00:00`).getDay(); // 0=Sun..6=Sat
}

export function templatesForDate(templates, dateStr) {
  const dow = String(dayOfWeek(dateStr));
  return templates.filter((t) => t.days_of_week.split(',').map((d) => d.trim()).includes(dow));
}

// A restaurant's templates routinely nest — e.g. "1 Opener, 9am-9:30pm" and
// "3 Mid AM, 9am-6pm" both legitimately run at once, and every Mid AM shift
// also technically fits inside the wider Opener window too. Attributing a
// shift to every template it merely fits inside would count those 3 Mid AM
// people against the Opener's minimum/maximum as well as their own — a
// shift instead belongs to whichever containing template is the tightest
// (smallest) fit, the most specific rule actually describing that slot,
// never more than one. See the identical note in client/coverage.js, which
// this mirrors for calendar rendering.
export function bestFitTemplate(templatesForThisDate, shift) {
  let best = null;
  let bestDuration = Infinity;
  for (const template of templatesForThisDate) {
    const [tStart, tEnd] = templateRange(template);
    const [sStart, sEnd] = shiftRange(shift);
    if (sStart < tStart || sEnd > tEnd) continue;
    const duration = tEnd - tStart;
    if (duration < bestDuration) {
      bestDuration = duration;
      best = template;
    }
  }
  return best;
}

// Returns a warning string (or null) for removing `userId` from `dateStr`
// entirely — used by a time-off day and by a shift-request delete/update
// vacating an existing shift.
function checkDateRemoval(templates, shifts, dateStr, userId) {
  const dayTemplates = templatesForDate(templates, dateStr);
  if (dayTemplates.length === 0) return [];
  const dayShifts = shifts.filter((s) => s.date === dateStr);

  // Assign every shift on this date to its single best-fit template before
  // checking anyone's minimum.
  const byTemplate = new Map();
  for (const s of dayShifts) {
    const template = bestFitTemplate(dayTemplates, s);
    if (!template) continue;
    if (!byTemplate.has(template)) byTemplate.set(template, []);
    byTemplate.get(template).push(s);
  }

  const warnings = [];
  for (const template of dayTemplates) {
    if (template.min_staff == null) continue;
    const covering = byTemplate.get(template) || [];
    if (!covering.some((s) => s.user_id === userId)) continue;
    const projected = covering.length - 1;
    if (projected < template.min_staff) {
      const start12 = format12(template.start_time);
      const end12 = format12(template.end_time);
      const friendly = formatFriendlyDate(dateStr);
      warnings.push(
        `Approving this will leave the ${friendly} ${start12}–${end12} "${template.name}" shift short-staffed. ` +
        `Only ${projected} ${projected === 1 ? 'person' : 'people'} would be available, but ${template.min_staff} ${template.min_staff === 1 ? 'is' : 'are'} scheduled to work it. ` +
        `Please find someone to cover this shift before approving.`
      );
    }
  }
  return warnings;
}

// For a time-off request spanning start_date..end_date.
export async function checkTimeOffCoverage(db, { user, start_date, end_date }) {
  const templates = await db.listShiftTemplates();
  if (templates.length === 0) return null;
  const shifts = await db.listShifts();

  const warnings = [];
  const cursor = new Date(`${start_date}T00:00:00`);
  const end = new Date(`${end_date}T00:00:00`);
  while (cursor <= end) {
    const dateStr = cursor.toISOString().slice(0, 10);
    warnings.push(...checkDateRemoval(templates, shifts, dateStr, user.id));
    cursor.setDate(cursor.getDate() + 1);
  }
  return warnings.length ? warnings.join(' ') : null;
}

// For a shift_request that vacates an existing shift (action 'update' or
// 'delete') — `shift` is the row being changed/removed.
export async function checkShiftRemovalCoverage(db, { shift }) {
  const templates = await db.listShiftTemplates();
  if (templates.length === 0) return null;
  const shifts = await db.listShifts();
  const warnings = checkDateRemoval(templates, shifts, shift.date, shift.user_id);
  return warnings.length ? warnings.join(' ') : null;
}
