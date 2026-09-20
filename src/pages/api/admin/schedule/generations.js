// Sprint 4 (PRD EPIC 7, WB-SCH-604): read-only audit trail for the
// auto-generation feature — "what did the system propose, on this date,
// and did a human accept it." Admin/manager only (middleware).
import db from '../../../../lib/db/index.js';

export const prerender = false;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

export async function GET(context) {
  const date = new URL(context.request.url).searchParams.get('date') || undefined;
  const generations = await db.listScheduleGenerations({ date });
  return json({ ok: true, generations });
}
