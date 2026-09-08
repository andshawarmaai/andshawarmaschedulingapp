// Creating shifts is admin/manager only — checked here (not via the
// ADMIN_ONLY_PREFIXES list in middleware.js, since GET on this same prefix
// could reasonably be opened to everyone later).
import db from '../../../lib/db/index.js';

export const prerender = false;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function isStaffOrAbove(user) {
  return user.role === 'admin' || user.role === 'manager';
}

export async function POST(context) {
  if (!isStaffOrAbove(context.locals.user)) {
    return json({ error: 'Only admins and managers can add shifts.' }, 403);
  }
  const body = await context.request.json().catch(() => null);
  if (!body || !body.date || !body.start_time || !body.end_time) {
    return json({ error: 'Date, start time, and end time are required.' }, 400);
  }
  const shift = await db.createShift({
    user_id: body.user_id || null,
    date: body.date,
    start_time: body.start_time,
    end_time: body.end_time,
    department: body.department || null,
    notes: body.notes || null,
  });
  return json({ ok: true, shift }, 201);
}
