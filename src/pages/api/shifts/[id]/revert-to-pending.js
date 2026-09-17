// "Un-commit" an already-scheduled shift back to a pending request — the
// reverse of approving one. Triggered by dragging an approved shift bar
// onto the Day view's roster row (admin/schedule.astro's
// wireCoverageInteractions). Admin/manager only, same gate as the other
// /api/shifts/:id actions in ../[id].js.
import db from '../../../../lib/db/index.js';

export const prerender = false;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function isStaffOrAbove(user) {
  return user.role === 'admin' || user.role === 'manager';
}

export async function POST(context) {
  if (!isStaffOrAbove(context.locals.user)) {
    return json({ error: 'Only admins and managers can do this.' }, 403);
  }
  const { id } = context.params;
  const request = await db.revertShiftToPending(id);
  if (!request) return json({ error: 'Shift not found.' }, 404);
  return json({ ok: true, request });
}
