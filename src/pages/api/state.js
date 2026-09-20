// Single aggregate read endpoint the client pages poll after every mutation.
// Kept intentionally simple (no per-field ACL matrix) because this is a
// small, trusted single-location staff tool — the same shape the old app
// used, just server-authoritative and without the localStorage split-brain.

import db from '../../lib/db/index.js';
import { publicUser } from '../../lib/publicUser.js';
import { isGeofenceConfigured } from '../../lib/geo.js';

export const prerender = false;

export async function GET(context) {
  const me = context.locals.user;
  const isStaffOrAbove = me.role === 'admin' || me.role === 'manager';

  const [users, shifts, timeOff, swapPosts, swapClaims, dayCaps, shiftRequests, shiftTemplates, jobs, myAvailability] = await Promise.all([
    db.listUsers(),
    db.listShifts(),
    db.listTimeOff(),
    db.listSwapPosts(),
    db.listSwapClaims(),
    db.listDayCaps(),
    db.listShiftRequests(),
    db.listShiftTemplates(),
    db.listJobs(),
    db.listAvailabilityRules(me.id),
  ]);

  const body = {
    me: publicUser(me),
    users: users.map(publicUser),
    shifts,
    swapPosts,
    swapClaims,
    dayCaps,
    shiftRequests,
    // Everyone gets this now, not just staff-or-above (it used to be
    // bundled in below) — staff need to read template names/times/days to
    // power the "quick fill" picker on their own availability submission
    // (schedule.astro), and there's no actual sensitivity here the way
    // there is for tiers below.
    shiftTemplates,
    // Job names aren't sensitive (same reasoning as shiftTemplates above) —
    // everyone needs them to make sense of qualification/proficiency badges
    // shown elsewhere. Which employee has which qualification/proficiency
    // stays admin-only below, same treatment as tiers.
    jobs: jobs.filter((j) => !j.disabled),
    availabilityMine: myAvailability,
    myJobQualifications: (await db.listEmployeeJobs({ user_id: me.id })),
    timeOffApproved: timeOff
      .filter((t) => t.status === 'approved')
      .map((t) => ({ user_id: t.user_id, start_date: t.start_date, end_date: t.end_date })),
    timeOffMine: timeOff.filter((t) => t.user_id === me.id),
    // The caller's own currently-open GPS check-in, if any — what the
    // Check In/Check Out card on the home page uses to know which of the
    // two to show. Not date-scoped by the client on purpose (there should
    // only ever be at most one open punch per person); "today" here is
    // the server's own clock, which only matters within a few minutes of
    // midnight and only affects this display hint, never the check-in
    // write itself (that always uses the caller's own device time).
    myOpenCheckIn: await db.findOpenActualWorkedShift(me.id, new Date().toISOString().slice(0, 10)),
    // Whether Check In/Out shows at all — a plain boolean, never the
    // actual coordinates, which stay admin-only (`locations` below).
    // Distance math always happens server-side in /api/checkin, so staff
    // never need to know the target coordinates to use this correctly.
    checkInAvailable: isGeofenceConfigured(await db.getPrimaryLocation()),
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
    body.employeeJobs = await db.listEmployeeJobs();
    body.employeeRoleProfiles = await db.listEmployeeRoleProfiles();
    body.locations = await db.listLocations();
  }

  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
