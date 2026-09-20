// Read-only peak-staffing-mix validation for one template on one date
// (Sprint 2, PRD WB-SCH-254/9.1's golden scenarios) — reuses the exact
// same shift-to-template matching coverage.js already uses for the
// min/max-staff warning, so "which shift counts toward this template" is
// answered identically everywhere in the app, not reimplemented per
// feature. Admin/manager only (middleware).
import db from '../../../../../lib/db/index.js';
import { templatesForDate, bestFitTemplate } from '../../../../../lib/coverage.js';
import { evaluateProficiencyMix } from '../../../../../lib/proficiencyMix.js';

export const prerender = false;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

export async function GET(context) {
  const { id } = context.params;
  const date = new URL(context.request.url).searchParams.get('date');
  if (!date) return json({ error: 'date query parameter (YYYY-MM-DD) is required.' }, 400);

  const template = await db.getShiftTemplateById(id);
  if (!template) return json({ error: 'Shift template not found.' }, 404);

  const requirements = await db.listTemplateJobRequirements(id);
  if (requirements.length === 0) return json({ ok: true, results: [], note: 'No peak-staffing-mix requirements configured for this template.' });

  const [allTemplates, allShifts, employeeJobs, roleProfiles] = await Promise.all([
    db.listShiftTemplates(), db.listShifts(), db.listEmployeeJobs(), db.listEmployeeRoleProfiles(),
  ]);

  // Same "one shift belongs to exactly one, best-fit template" rule the
  // min/max-staff coverage warning already uses (coverage.js) — a shift
  // that doesn't best-fit THIS template doesn't count toward it, even if
  // it technically overlaps its time window.
  const dayTemplates = templatesForDate(allTemplates, date);
  const dayShifts = allShifts.filter((s) => s.date === date);
  const assignedToThisTemplate = dayShifts.filter((s) => bestFitTemplate(dayTemplates, s)?.id === template.id);

  const roleProfileByUserJob = new Map(roleProfiles.map((p) => [`${p.user_id}::${p.job_id}`, p.proficiency]));
  const qualifiedJobsByUser = new Map();
  for (const ej of employeeJobs) {
    if (ej.qualification_state !== 'qualified') continue;
    if (!qualifiedJobsByUser.has(ej.user_id)) qualifiedJobsByUser.set(ej.user_id, []);
    qualifiedJobsByUser.get(ej.user_id).push(ej.job_id);
  }

  // An assigned person can count toward whichever job(s) they're qualified
  // for among this template's requirements — there's no per-shift job
  // assignment column yet (shifts.department is free text, not a job_id),
  // so for now every qualified job for that person is evaluated against
  // this template's requirements. Revisit once shifts carry a job_id
  // directly (a natural Sprint 3 follow-up once the optimizer needs it).
  const assignments = [];
  for (const shift of assignedToThisTemplate) {
    const jobs = qualifiedJobsByUser.get(shift.user_id) || [];
    for (const job_id of jobs) {
      assignments.push({ user_id: shift.user_id, job_id, proficiency: roleProfileByUserJob.get(`${shift.user_id}::${job_id}`) || null });
    }
  }

  const results = evaluateProficiencyMix({ requirements, assignments });
  return json({ ok: true, date, template_id: id, assigned_count: assignedToThisTemplate.length, results });
}
