// Sprint 3 (PRD EPIC 6/7): the explicit, human-triggered step that turns
// an accepted proposal from .../generate into real shift rows. This is
// the only place a generated assignment is ever persisted — never
// automatic, matching the PRD's "Manager remains accountable: AI
// proposes; rules validate; authorized manager publishes" principle.
// The caller sends back exactly the assignments it wants applied (the
// manager may have dropped some after reviewing the proposal), so this
// re-checks nothing beyond what createShift itself already guarantees —
// it trusts the caller reviewed the proposal, the same trust boundary
// every other admin-authored shift already has.
import db from '../../../../lib/db/index.js';

export const prerender = false;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

export async function POST(context) {
  const body = await context.request.json().catch(() => null);
  if (!body || !Array.isArray(body.assignments) || body.assignments.length === 0) {
    return json({ error: 'assignments (a non-empty array) is required.' }, 400);
  }
  const created = [];
  for (const a of body.assignments) {
    if (!a.user_id || !a.date || !a.start_time || !a.end_time) {
      return json({ error: 'Every assignment needs user_id, date, start_time, and end_time.', partial: created }, 400);
    }
    const shift = await db.createShift({ user_id: a.user_id, date: a.date, start_time: a.start_time, end_time: a.end_time, job_id: a.job_id || null });
    created.push(shift);
  }

  // Links back to the immutable proposal this came from (Sprint 4) — the
  // generation row itself already has the full "what was proposed" record
  // from .../generate; this just closes the loop with "and here's what a
  // human actually accepted, when, and by whom."
  if (body.generation_id) {
    await db.markScheduleGenerationApplied(body.generation_id, {
      applied_shift_ids: created.map((s) => s.id).join(','), applied_by: context.locals.user.id,
    }).catch(() => {}); // best-effort — a bad/stale generation_id should never block the real shifts that already got created above
  }

  return json({ ok: true, shifts: created }, 201);
}
