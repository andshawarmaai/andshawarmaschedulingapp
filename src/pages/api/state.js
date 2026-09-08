// Single aggregate read endpoint the client pages poll after every mutation.
// Kept intentionally simple (no per-field ACL matrix) because this is a
// small, trusted single-location staff tool — the same shape the old app
// used, just server-authoritative and without the localStorage split-brain.

import db from '../../lib/db/index.js';
import { publicUser } from '../../lib/publicUser.js';

export const prerender = false;

export async function GET(context) {
  const me = context.locals.user;
  const isStaffOrAbove = me.role === 'admin' || me.role === 'manager';

  const [users, shifts, timeOff, swapPosts, swapClaims, dayCaps, shiftRequests] = await Promise.all([
    db.listUsers(),
    db.listShifts(),
    db.listTimeOff(),
    db.listSwapPosts(),
    db.listSwapClaims(),
    db.listDayCaps(),
    db.listShiftRequests(),
  ]);

  const body = {
    me: publicUser(me),
    users: users.map(publicUser),
    shifts,
    swapPosts,
    swapClaims,
    dayCaps,
    shiftRequests,
    timeOffApproved: timeOff
      .filter((t) => t.status === 'approved')
      .map((t) => ({ user_id: t.user_id, start_date: t.start_date, end_date: t.end_date })),
    timeOffMine: timeOff.filter((t) => t.user_id === me.id),
  };
  if (isStaffOrAbove) {
    body.timeOffAll = timeOff;
    body.shiftImports = await db.listShiftImports();
  }

  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
