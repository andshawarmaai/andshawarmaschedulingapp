// Computes a non-blocking staffing warning when a request would remove
// someone from a shift covered by a recurring shift_template's minimum
// (see db/schema.sql). Unlike tierLimits.js, this never denies anything —
// it only attaches a human-readable heads-up to a request that still goes
// to Pending Approvals as normal, so whoever decides can see the tradeoff.

function toMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

// End-exclusive minute range for `template` as it applies to the specific
// calendar date it *starts* on. end can exceed 1440 when the block
// crosses midnight (e.g. 16:30-02:30 => [990, 1590)).
function templateRange(template) {
  const start = toMinutes(template.start_time);
  let end = toMinutes(template.end_time);
  if (end <= start) end += 24 * 60;
  return [start, end];
}

function shiftRange(shift) {
  const start = toMinutes(shift.start_time);
  let end = toMinutes(shift.end_time);
  if (end <= start) end += 24 * 60;
  return [start, end];
}

function dayOfWeek(dateStr) {
  return new Date(`${dateStr}T00:00:00`).getDay(); // 0=Sun..6=Sat
}

function templatesForDate(templates, dateStr) {
  const dow = String(dayOfWeek(dateStr));
  return templates.filter((t) => t.days_of_week.split(',').map((d) => d.trim()).includes(dow));
}

// Shifts on `dateStr` whose time range overlaps `template`'s window for
// that date (both wraparound-aware).
function shiftsCoveringTemplate(shifts, template, dateStr) {
  const [tStart, tEnd] = templateRange(template);
  return shifts.filter((s) => {
    if (s.date !== dateStr) return false;
    const [sStart, sEnd] = shiftRange(s);
    return sStart < tEnd && tStart < sEnd;
  });
}

// Returns a warning string (or null) for removing `userId` from `dateStr`
// entirely — used by a time-off day and by a shift-request delete/update
// vacating an existing shift.
function checkDateRemoval(templates, shifts, dateStr, userId) {
  const warnings = [];
  for (const template of templatesForDate(templates, dateStr)) {
    if (template.min_staff == null) continue;
    const covering = shiftsCoveringTemplate(shifts, template, dateStr);
    if (!covering.some((s) => s.user_id === userId)) continue;
    const projected = covering.length - 1;
    if (projected < template.min_staff) {
      warnings.push(`${dateStr}: "${template.name}" (${template.start_time}-${template.end_time}) would drop to ${projected} staff, below its minimum of ${template.min_staff}.`);
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
