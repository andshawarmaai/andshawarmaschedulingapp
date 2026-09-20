// Recurring weekly availability (Sprint 1, PRD EPIC 4 / WB-SCH-301) — "I'm
// never available Tuesdays," distinct from time_off_requests' date-specific
// "I need next Tuesday off." Self-service: every signed-in user manages
// their own rows here; state.js already returns the caller's own rules
// under availabilityMine.
import db from '../../../lib/db/index.js';

export const prerender = false;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

const TIME_RE = /^\d{2}:\d{2}$/;

export async function POST(context) {
  const me = context.locals.user;
  const body = await context.request.json().catch(() => null);
  if (!body) return json({ error: 'Invalid request body.' }, 400);

  const day_of_week = Number(body.day_of_week);
  if (!Number.isInteger(day_of_week) || day_of_week < 0 || day_of_week > 6) {
    return json({ error: 'day_of_week must be an integer 0 (Sunday) through 6 (Saturday).' }, 400);
  }
  if (!TIME_RE.test(body.start_time) || !TIME_RE.test(body.end_time)) {
    return json({ error: 'start_time and end_time must be in HH:MM format.' }, 400);
  }

  const row = await db.createAvailabilityRule({
    user_id: me.id,
    day_of_week,
    start_time: body.start_time,
    end_time: body.end_time,
    effective_from: body.effective_from || null,
    effective_to: body.effective_to || null,
  });
  return json({ ok: true, availability: row }, 201);
}
