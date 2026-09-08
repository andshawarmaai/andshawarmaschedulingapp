import db from '../../../lib/db/index.js';

export const prerender = false;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function isStaffOrAbove(user) {
  return user.role === 'admin' || user.role === 'manager';
}

export async function PATCH(context) {
  if (!isStaffOrAbove(context.locals.user)) {
    return json({ error: 'Only admins and managers can edit shifts.' }, 403);
  }
  const { id } = context.params;
  const body = await context.request.json().catch(() => null);
  if (!body) return json({ error: 'Invalid request body.' }, 400);
  const shift = await db.updateShift(id, {
    user_id: body.user_id !== undefined ? body.user_id || null : undefined,
    date: body.date,
    start_time: body.start_time,
    end_time: body.end_time,
    department: body.department,
    notes: body.notes,
  });
  if (!shift) return json({ error: 'Shift not found.' }, 404);
  return json({ ok: true, shift });
}

export async function DELETE(context) {
  if (!isStaffOrAbove(context.locals.user)) {
    return json({ error: 'Only admins and managers can delete shifts.' }, 403);
  }
  const { id } = context.params;
  const existing = await db.getShiftById(id);
  if (!existing) return json({ error: 'Shift not found.' }, 404);
  await db.deleteShift(id);
  return json({ ok: true });
}
