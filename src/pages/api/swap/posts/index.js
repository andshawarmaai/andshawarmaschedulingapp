import db from '../../../../lib/db/index.js';

export const prerender = false;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

export async function POST(context) {
  const me = context.locals.user;
  const body = await context.request.json().catch(() => null);
  if (!body || !body.shift_id) return json({ error: 'shift_id is required.' }, 400);

  const shift = await db.getShiftById(body.shift_id);
  if (!shift) return json({ error: 'Shift not found.' }, 404);
  if (shift.user_id !== me.id && me.role !== 'admin' && me.role !== 'manager') {
    return json({ error: 'You can only post your own shifts for swap.' }, 403);
  }

  const post = await db.createSwapPost({
    shift_id: shift.id,
    user_id: shift.user_id,
    reason: body.reason ? String(body.reason).trim() : null,
  });
  return json({ ok: true, post }, 201);
}
