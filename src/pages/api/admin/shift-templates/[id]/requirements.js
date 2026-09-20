// Peak staffing mix per shift template (Sprint 2, PRD EPIC 3/5 / WB-SCH-253).
// Admin/manager only (middleware ADMIN_ONLY_PREFIXES covers /api/admin).
import db from '../../../../../lib/db/index.js';

export const prerender = false;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function parseCount(value, fieldName) {
  const n = Number(value ?? 0);
  if (!Number.isInteger(n) || n < 0) return { ok: false, error: `${fieldName} must be a whole number ≥ 0.` };
  return { ok: true, value: n };
}

export async function GET(context) {
  const { id } = context.params;
  const requirements = await db.listTemplateJobRequirements(id);
  return json({ ok: true, requirements });
}

export async function POST(context) {
  const { id } = context.params;
  const template = await db.getShiftTemplateById(id);
  if (!template) return json({ error: 'Shift template not found.' }, 404);

  const body = await context.request.json().catch(() => null);
  if (!body || !body.job_id) return json({ error: 'job_id is required.' }, 400);
  const job = await db.getJobById(body.job_id);
  if (!job) return json({ error: 'Job not found.' }, 404);

  const minCount = parseCount(body.min_count, 'min_count');
  if (!minCount.ok) return json({ error: minCount.error }, 400);
  const minAdvanced = parseCount(body.min_advanced_count, 'min_advanced_count');
  if (!minAdvanced.ok) return json({ error: minAdvanced.error }, 400);
  const minProfPlus = parseCount(body.min_proficient_or_better_count, 'min_proficient_or_better_count');
  if (!minProfPlus.ok) return json({ error: minProfPlus.error }, 400);

  const requirement = await db.setTemplateJobRequirement({
    shift_template_id: id, job_id: body.job_id,
    min_count: minCount.value, min_advanced_count: minAdvanced.value, min_proficient_or_better_count: minProfPlus.value,
  });
  return json({ ok: true, requirement }, 201);
}

export async function DELETE(context) {
  const { id } = context.params;
  const body = await context.request.json().catch(() => null);
  if (!body || !body.job_id) return json({ error: 'job_id is required.' }, 400);
  await db.deleteTemplateJobRequirement(id, body.job_id);
  return json({ ok: true });
}
