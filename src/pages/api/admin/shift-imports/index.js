// Bulk CSV shift import. Gated to admin/manager by middleware.js
// (ADMIN_ONLY_PREFIXES covers /api/admin). All-or-nothing: every row must
// validate before anything is written, so a bad upload never silently
// drops rows onto the calendar.
import db from '../../../../lib/db/index.js';

export const prerender = false;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;
const DEPARTMENTS = new Set(['', 'FOH', 'BOH']);

export async function POST(context) {
  const me = context.locals.user;
  const body = await context.request.json().catch(() => null);
  if (!body || !Array.isArray(body.rows) || body.rows.length === 0) {
    return json({ error: 'No rows to import.' }, 400);
  }
  if (body.rows.length > 1000) {
    return json({ error: 'Too many rows in one upload (max 1000).' }, 400);
  }

  const users = await db.listUsers();
  const byUsername = new Map(users.map((u) => [u.username.toLowerCase(), u]));

  const errors = [];
  const resolved = [];
  body.rows.forEach((row, i) => {
    const line = i + 2; // +1 for 0-index, +1 for the header row
    const username = String(row.username || '').trim();
    const date = String(row.date || '').trim();
    const start_time = String(row.start_time || '').trim();
    const end_time = String(row.end_time || '').trim();
    const department = String(row.department || '').trim().toUpperCase();
    const notes = row.notes ? String(row.notes).trim() : null;

    const user = byUsername.get(username.toLowerCase());
    if (!username) errors.push(`Row ${line}: username is required.`);
    else if (!user) errors.push(`Row ${line}: no user with username "${username}".`);
    if (!DATE_RE.test(date)) errors.push(`Row ${line}: date must be YYYY-MM-DD (got "${date}").`);
    if (!TIME_RE.test(start_time)) errors.push(`Row ${line}: start_time must be HH:MM (got "${start_time}").`);
    if (!TIME_RE.test(end_time)) errors.push(`Row ${line}: end_time must be HH:MM (got "${end_time}").`);
    if (TIME_RE.test(start_time) && TIME_RE.test(end_time) && start_time >= end_time) {
      errors.push(`Row ${line}: start_time must be before end_time.`);
    }
    if (!DEPARTMENTS.has(department)) errors.push(`Row ${line}: department must be FOH, BOH, or blank (got "${department}").`);

    if (user && DATE_RE.test(date) && TIME_RE.test(start_time) && TIME_RE.test(end_time)) {
      resolved.push({ user_id: user.id, date, start_time, end_time, department: department || null, notes });
    }
  });

  if (errors.length > 0) {
    return json({ error: 'Fix these rows and re-upload — nothing was imported.', rowErrors: errors.slice(0, 50) }, 400);
  }

  const importRow = await db.createShiftImport({
    uploaded_by: me.id,
    filename: body.filename ? String(body.filename).slice(0, 200) : null,
    row_count: resolved.length,
  });
  for (const shift of resolved) {
    await db.createShift({ ...shift, import_id: importRow.id });
  }

  return json({ ok: true, import: importRow, count: resolved.length }, 201);
}
