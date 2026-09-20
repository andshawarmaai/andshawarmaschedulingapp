// Employee job qualification (Sprint 1, PRD EPIC 2 / WB-SCH-202). Gates
// whether an employee can be scheduled into a job at all — separate from,
// and a prerequisite for, the role-specific proficiency set via
// /api/admin/employee-role-profiles below. Admin/manager only (middleware).
import db from '../../../lib/db/index.js';

export const prerender = false;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

const STATES = new Set(['not_qualified', 'training', 'qualified']);

export async function POST(context) {
  const me = context.locals.user;
  const body = await context.request.json().catch(() => null);
  if (!body || !body.user_id || !body.job_id) return json({ error: 'user_id and job_id are required.' }, 400);
  if (!STATES.has(body.qualification_state)) {
    return json({ error: `qualification_state must be one of: ${[...STATES].join(', ')}.` }, 400);
  }
  const [user, job] = await Promise.all([db.getUserById(body.user_id), db.getJobById(body.job_id)]);
  if (!user) return json({ error: 'Employee not found.' }, 404);
  if (!job) return json({ error: 'Job not found.' }, 404);

  const effective_date = body.effective_date || new Date().toISOString().slice(0, 10);
  const row = await db.setEmployeeJob({
    user_id: body.user_id, job_id: body.job_id, qualification_state: body.qualification_state, effective_date, created_by: me.id,
  });

  // Demoting below 'qualified' invalidates any proficiency profile for this
  // job — proficiency is only meaningful for someone currently qualified,
  // and leaving a stale one around would let it silently reappear if the
  // employee is later re-qualified without a manager noticing it's old.
  if (body.qualification_state !== 'qualified') {
    await db.deleteEmployeeRoleProfile(body.user_id, body.job_id).catch(() => {});
  }

  return json({ ok: true, employeeJob: row }, 201);
}

export async function DELETE(context) {
  const body = await context.request.json().catch(() => null);
  if (!body || !body.user_id || !body.job_id) return json({ error: 'user_id and job_id are required.' }, 400);
  await db.deleteEmployeeJob(body.user_id, body.job_id);
  return json({ ok: true });
}
