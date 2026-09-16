// Gated to admin/manager by middleware.js (ADMIN_ONLY_PREFIXES covers
// /api/admin) — unlike tiers, shift templates aren't a secret from
// managers, they're just recurring coverage rules.
import db from '../../../../lib/db/index.js';
import { parseDaysOfWeek, parseStaffCount } from '../../../../lib/shiftTemplateFields.js';

export const prerender = false;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

const TIME_RE = /^\d{2}:\d{2}$/;

export async function POST(context) {
  const body = await context.request.json().catch(() => null);
  const name = (body && body.name ? String(body.name) : '').trim();
  if (!name) return json({ error: 'A name is required (e.g. "Opener" or "Late night").' }, 400);

  const days_of_week = body && parseDaysOfWeek(body.days_of_week);
  if (!days_of_week) return json({ error: 'Pick at least one day of the week.' }, 400);

  const start_time = body && String(body.start_time || '').trim();
  const end_time = body && String(body.end_time || '').trim();
  if (!TIME_RE.test(start_time) || !TIME_RE.test(end_time)) {
    return json({ error: 'Start and end time must be HH:MM (24h). End before start is fine — it means the shift crosses midnight.' }, 400);
  }

  const minParsed = parseStaffCount(body && body.min_staff);
  const maxParsed = parseStaffCount(body && body.max_staff);
  if (!minParsed.ok) return json({ error: 'min_staff must be a whole number ≥ 0, or blank.' }, 400);
  if (!maxParsed.ok) return json({ error: 'max_staff must be a whole number ≥ 0, or blank.' }, 400);

  const template = await db.createShiftTemplate({
    name, days_of_week, start_time, end_time,
    min_staff: minParsed.value, max_staff: maxParsed.value,
  });
  return json({ ok: true, template }, 201);
}
