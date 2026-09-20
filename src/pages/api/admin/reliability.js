// Sprint 7 (PRD WB-SCH-252): read-only factual reliability signal for one
// employee over a date range — attendance/punctuality counts, never a
// single score. Admin/manager only (middleware).
import db from '../../../lib/db/index.js';
import { computeReliability } from '../../../lib/reliability.js';

export const prerender = false;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

export async function GET(context) {
  const url = new URL(context.request.url);
  const user_id = url.searchParams.get('user_id');
  const date_from = url.searchParams.get('date_from');
  const date_to = url.searchParams.get('date_to');
  if (!user_id || !date_from || !date_to) return json({ error: 'user_id, date_from, and date_to query params are required.' }, 400);

  const [allShifts, actualWorkedShifts] = await Promise.all([
    db.listShifts(), db.listActualWorkedShifts({ user_id, date_from, date_to }),
  ]);
  const scheduledShifts = allShifts.filter((s) => s.user_id === user_id && s.date >= date_from && s.date <= date_to);

  const result = computeReliability({ scheduledShifts, actualWorkedShifts });
  return json({ ok: true, user_id, date_from, date_to, ...result });
}
