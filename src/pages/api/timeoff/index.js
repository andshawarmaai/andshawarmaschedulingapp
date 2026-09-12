import db from '../../../lib/db/index.js';
import { checkTimeOffLimit } from '../../../lib/tierLimits.js';

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

  const row = await db.createTimeOff({
    user_id: me.id,
    start_date: body.start_date,
    end_date: body.end_date,
    reason: body.reason ? String(body.reason).trim() : null,
    status: denialReason ? 'denied' : 'pending',
    denial_reason: denialReason,
  });
  return json({ ok: true, timeOff: row }, 201);
}
