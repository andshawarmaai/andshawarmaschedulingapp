// Role-specific proficiency (Sprint 1, PRD EPIC 3). Deliberately NOT a
// single global "good/bad employee" score — tracked per job, with an
// effective date and the admin who set it. Requires the employee already
// be 'qualified' on that job (see /api/admin/employee-jobs.js): proficiency
// ranks among eligible people, it never substitutes for eligibility.
// Admin/manager only (middleware).
import db from '../../../lib/db/index.js';

export const prerender = false;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

const TIERS = new Set(['developing', 'proficient', 'advanced']);

export async function POST(context) {
  const me = context.locals.user;
  const body = await context.request.json().catch(() => null);
  if (!body || !body.user_id || !body.job_id) return json({ error: 'user_id and job_id are required.' }, 400);
  if (!TIERS.has(body.proficiency)) return json({ error: `proficiency must be one of: ${[...TIERS].join(', ')}.` }, 400);

  const [qualifications] = await Promise.all([db.listEmployeeJobs({ user_id: body.user_id, job_id: body.job_id })]);
  const qualification = qualifications[0];
  if (!qualification || qualification.qualification_state !== 'qualified') {
    return json({ error: 'This employee must be marked "qualified" for this job before a proficiency tier can be set.' }, 400);
  }

  const effective_date = body.effective_date || new Date().toISOString().slice(0, 10);
  const profile = await db.setEmployeeRoleProfile({
    user_id: body.user_id, job_id: body.job_id, proficiency: body.proficiency,
    effective_date, source: body.source ? String(body.source).trim() : null, created_by: me.id,
  });
  return json({ ok: true, profile }, 201);
}

export async function DELETE(context) {
  const body = await context.request.json().catch(() => null);
  if (!body || !body.user_id || !body.job_id) return json({ error: 'user_id and job_id are required.' }, 400);
  await db.deleteEmployeeRoleProfile(body.user_id, body.job_id);
  return json({ ok: true });
}
