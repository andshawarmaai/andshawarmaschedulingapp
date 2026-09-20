import db from '../../../lib/db/index.js';

export const prerender = false;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function isStaffOrAbove(user) {
  return user.role === 'admin' || user.role === 'manager';
}

export async function DELETE(context) {
  const { id } = context.params;
  const me = context.locals.user;
  // Admin/manager can clear anyone's rule (e.g. cleaning up on an
  // employee's behalf); everyone else can only delete their own — same
  // ownership pattern as the time-off DELETE route.
  const ok = await db.deleteAvailabilityRule(id, isStaffOrAbove(me) ? undefined : me.id);
  if (!ok) return json({ error: 'Rule not found, or it belongs to someone else.' }, 404);
  return json({ ok: true });
}
