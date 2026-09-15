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
  const body = await context.request.json().catch(() => null);
  if (!body) return json({ error: 'Invalid request body.' }, 400);

  // Re-proposing the date/time on a still-pending request — the calendar's
  // drag-to-reschedule. Deliberately admin/manager only (unlike time off's
  // owner-edit path): this is a manager sorting out a conflict, not a
  // staff member changing their own ask.
  if (body.status === undefined) {
    if (!isStaffOrAbove(context.locals.user)) {
      return json({ error: 'Only admins and managers can reschedule a request.' }, 403);
    }
    const req = await db.getShiftRequestById(id);
    if (!req) return json({ error: 'Request not found.' }, 404);
    if (req.status !== 'pending') return json({ error: `Already ${req.status}.`, status: req.status }, 409);
    const updates = {};
    if (body.date) updates.date = body.date;
    if (body.start_time) updates.start_time = body.start_time;
    if (body.end_time) updates.end_time = body.end_time;
    const updated = await db.updateShiftRequest(id, updates);
    return json({ ok: true, request: updated });
  }

  if (!isStaffOrAbove(context.locals.user)) {
    return json({ error: 'Only admins and managers can approve or deny shift requests.' }, 403);
  }
  if (body.status !== 'approved' && body.status !== 'denied') {
    return json({ error: 'status must be "approved" or "denied".' }, 400);
  }

  if (body.status === 'denied') {
    const req = await db.getShiftRequestById(id);
    if (!req) return json({ error: 'Request not found.' }, 404);
    if (req.status !== 'pending') return json({ error: `Already ${req.status}.`, status: req.status }, 409);
    const updated = await db.updateShiftRequest(id, {
      status: 'denied',
      denial_reason: body.denial_reason ? String(body.denial_reason).trim() : 'No reason given',
    });
    return json({ ok: true, request: updated });
  }

  const result = await db.approveShiftRequestTx(id);
  if (result.error === 'not_found') return json({ error: 'Request not found.' }, 404);
  if (result.error === 'already_resolved') return json({ error: `Already ${result.status}.`, status: result.status }, 409);
  if (result.error === 'shift_missing') return json({ error: 'That shift no longer exists.' }, 409);
  if (result.error) return json({ error: 'Could not approve this request.' }, 500);
  return json({ ok: true });
}

export async function DELETE(context) {
  const { id } = context.params;
  const me = context.locals.user;
  const req = await db.getShiftRequestById(id);
  if (!req) return json({ error: 'Request not found.' }, 404);
  if (req.user_id !== me.id && !isStaffOrAbove(me)) {
    return json({ error: 'You can only cancel your own requests.' }, 403);
  }
  if (req.status !== 'pending') {
    return json({ error: 'Only pending requests can be cancelled.' }, 409);
  }
  await db.deleteShiftRequest(id);
  return json({ ok: true });
}
