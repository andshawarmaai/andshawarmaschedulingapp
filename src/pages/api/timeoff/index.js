import db from '../../../lib/db/index.js';

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
  const row = await db.createTimeOff({
    user_id: context.locals.user.id,
    start_date: body.start_date,
    end_date: body.end_date,
    reason: body.reason ? String(body.reason).trim() : null,
  });
  return json({ ok: true, timeOff: row }, 201);
}
