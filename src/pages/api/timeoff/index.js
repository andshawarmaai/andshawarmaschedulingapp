import db from '../../../lib/db/index.js';
import { checkTimeOffLimit } from '../../../lib/tierLimits.js';
import { checkTimeOffCoverage } from '../../../lib/coverage.js';

export const prerender = false;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

export async function POST(context) {
  const body = await context.request.json().catch(() => null);
  if (!body || !body.start_date || !body.end_date) {
    return json({ error: 'Start date and end date are required.' }, 400);
  }
  if (body.end_date < body.start_date) {
    return json({ error: 'End date must be on or after the start date.' }, 400);
  }

  // Re-fetch the full user row rather than trusting the session — tier_id
  // isn't in the session payload, and a tier reassignment should take
  // effect on the very next request, not after the next login.
  const me = await db.getUserById(context.locals.user.id);
  const denialReason = await checkTimeOffLimit(db, { user: me, start_date: body.start_date, end_date: body.end_date });
  // Only worth flagging a staffing conflict if this isn't already denied.
  const staffingWarning = denialReason ? null : await checkTimeOffCoverage(db, { user: me, start_date: body.start_date, end_date: body.end_date });

  // A tier can opt in to auto-approving its members' requests, but only
  // when the request is already within that tier's own caps (denialReason
  // null) — this never overrides the cap, it only skips the manual-review
  // step for a request the tier already permits. A staffing conflict still
  // forces manual review regardless of the tier's auto-approve setting —
  // coverage impact always needs a human look, same as it would for anyone
  // without auto-approve.
  let status = denialReason ? 'denied' : 'pending';
  if (!denialReason && !staffingWarning && me.tier_id) {
    const tier = await db.getTierById(me.tier_id);
    if (tier && tier.auto_approve_time_off) status = 'approved';
  }

  const row = await db.createTimeOff({
    user_id: me.id,
    start_date: body.start_date,
    end_date: body.end_date,
    reason: body.reason ? String(body.reason).trim() : null,
    status,
    denial_reason: denialReason,
    staffing_warning: staffingWarning,
  });
  return json({ ok: true, timeOff: row }, 201);
}
