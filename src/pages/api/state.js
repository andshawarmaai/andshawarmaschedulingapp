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
    const apiKeys = await db.listApiKeys();
    body.apiKeys = apiKeys.map((k) => ({
      id: k.id, label: k.label, key_prefix: k.key_prefix, created_by: k.created_by,
      created_at: k.created_at, last_used_at: k.last_used_at, revoked: k.revoked,
    }));
    body.passwordResetRequests = (await db.listPasswordResetRequests()).filter((r) => !r.resolved_at);
  }
  if (me.role === 'admin') {
    // Tiers (and who's on which) are admin-only — deliberately kept out of
    // the `users` array everyone else receives above, rather than gated by
    // field, so a tier assignment is never present in a non-admin's
    // response at all.
    body.tiers = await db.listTiers();
    body.userTiers = Object.fromEntries(users.map((u) => [u.id, u.tier_id || null]));
  }

  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
