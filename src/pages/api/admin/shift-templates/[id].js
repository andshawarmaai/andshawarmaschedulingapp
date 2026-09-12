import db from '../../../../lib/db/index.js';

export const prerender = false;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

const TIME_RE = /^\d{2}:\d{2}$/;

function parseDaysOfWeek(value) {
  const days = Array.isArray(value) ? value : String(value || '').split(',');
  const nums = days.map((d) => Number(d)).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6);
  const unique = [...new Set(nums)].sort((a, b) => a - b);
  return unique.length ? unique.join(',') : null;
}

function parseStaffCount(value) {
  if (value === null || value === undefined || value === '') return { ok: true, value: null };
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) return { ok: false };
  return { ok: true, value: n };
}

export async function PATCH(context) {
  const { id } = context.params;
  const body = await context.request.json().catch(() => null);
  if (!body) return json({ error: 'Invalid request body.' }, 400);

  const updates = {};
  if (body.name !== undefined) {
    const name = String(body.name).trim();
    if (!name) return json({ error: 'Name cannot be blank.' }, 400);
    updates.name = name;
  }
  if (body.days_of_week !== undefined) {
    const days_of_week = parseDaysOfWeek(body.days_of_week);
    if (!days_of_week) return json({ error: 'Pick at least one day of the week.' }, 400);
    updates.days_of_week = days_of_week;
  }
  if (body.start_time !== undefined) {
    if (!TIME_RE.test(body.start_time)) return json({ error: 'start_time must be HH:MM.' }, 400);
    updates.start_time = body.start_time;
  }
  if (body.end_time !== undefined) {
    if (!TIME_RE.test(body.end_time)) return json({ error: 'end_time must be HH:MM.' }, 400);
    updates.end_time = body.end_time;
  }
  if (body.min_staff !== undefined) {
    const parsed = parseStaffCount(body.min_staff);
    if (!parsed.ok) return json({ error: 'min_staff must be a whole number ≥ 0, or blank.' }, 400);
    updates.min_staff = parsed.value;
  }
  if (body.max_staff !== undefined) {
    const parsed = parseStaffCount(body.max_staff);
    if (!parsed.ok) return json({ error: 'max_staff must be a whole number ≥ 0, or blank.' }, 400);
    updates.max_staff = parsed.value;
  }

  const template = await db.updateShiftTemplate(id, updates);
  if (!template) return json({ error: 'Shift template not found.' }, 404);
  return json({ ok: true, template });
}

export async function DELETE(context) {
  const { id } = context.params;
  await db.deleteShiftTemplate(id);
  return json({ ok: true });
}
