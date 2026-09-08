// Staff request a shift create/update/delete; admin/manager approve it in
// the Manage queue (see [id].js). Admins/managers don't need this endpoint —
// they use /api/shifts directly — but nothing stops them using it too.
import db from '../../../lib/db/index.js';

export const prerender = false;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

const ACTIONS = new Set(['create', 'update', 'delete']);

export async function POST(context) {
  const me = context.locals.user;
  const body = await context.request.json().catch(() => null);
  if (!body || !ACTIONS.has(body.action)) {
    return json({ error: 'action must be "create", "update", or "delete".' }, 400);
  }

  if (body.action === 'create') {
    if (!body.date || !body.start_time || !body.end_time) {
      return json({ error: 'Date, start time, and end time are required.' }, 400);
    }
  } else {
    // update / delete both need an existing shift the requester owns.
    if (!body.shift_id) return json({ error: 'shift_id is required.' }, 400);
    const shift = await db.getShiftById(body.shift_id);
    if (!shift) return json({ error: 'Shift not found.' }, 404);
    if (shift.user_id !== me.id && me.role !== 'admin' && me.role !== 'manager') {
      return json({ error: 'You can only request changes to your own shifts.' }, 403);
    }
    if (body.action === 'update' && (!body.date || !body.start_time || !body.end_time)) {
      return json({ error: 'Date, start time, and end time are required.' }, 400);
    }
  }

  const request = await db.createShiftRequest({
    user_id: me.id,
    action: body.action,
    shift_id: body.shift_id || null,
    date: body.date || null,
    start_time: body.start_time || null,
    end_time: body.end_time || null,
    department: body.department || null,
    notes: body.notes || null,
  });
  return json({ ok: true, request }, 201);
}
