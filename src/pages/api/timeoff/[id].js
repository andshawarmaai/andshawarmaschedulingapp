import db from '../../../lib/db/index.js';

export const prerender = false;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function isStaffOrAbove(user) {
  return user.role === 'admin' || user.role === 'manager';
}

export async function PATCH(context) {
  const { id } = context.params;
  const me = context.locals.user;
  const row = await db.getTimeOffById(id);
  if (!row) return json({ error: 'Request not found.' }, 404);

  const body = await context.request.json().catch(() => null);
  if (!body) return json({ error: 'Invalid request body.' }, 400);

  const isOwner = row.user_id === me.id;
  const isReview = body.status === 'approved' || body.status === 'denied';

  if (isReview) {
    if (!isStaffOrAbove(me)) return json({ error: 'Only admins and managers can approve or deny requests.' }, 403);
    if (row.status !== 'pending') {
      return json({ error: `Already ${row.status}.`, status: row.status }, 409);
    }
    const updated = await db.updateTimeOff(id, {
      status: body.status,
      denial_reason: body.status === 'denied' ? (body.denial_reason ? String(body.denial_reason).trim() : 'No reason given') : null,
    });
    return json({ ok: true, timeOff: updated });
  }

  // Editing dates/reason — owner only, and only while still pending.
  if (!isOwner && !isStaffOrAbove(me)) {
    return json({ error: 'You can only edit your own requests.' }, 403);
  }
  if (row.status !== 'pending') {
    return json({ error: 'Only pending requests can be edited.' }, 409);
  }
  const updates = {};
  if (body.start_date) updates.start_date = body.start_date;
  if (body.end_date) updates.end_date = body.end_date;
  if (body.reason !== undefined) updates.reason = body.reason ? String(body.reason).trim() : null;
  const updated = await db.updateTimeOff(id, updates);
  return json({ ok: true, timeOff: updated });
}

export async function DELETE(context) {
  const { id } = context.params;
  const me = context.locals.user;
  const row = await db.getTimeOffById(id);
  if (!row) return json({ error: 'Request not found.' }, 404);
  if (row.user_id !== me.id && !isStaffOrAbove(me)) {
    return json({ error: 'You can only cancel your own requests.' }, 403);
  }
  await db.deleteTimeOff(id);
  return json({ ok: true });
}
