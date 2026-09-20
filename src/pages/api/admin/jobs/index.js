// Jobs/roles (Sprint 1, PRD EPIC 2) — the operational positions
// ("Shawarma Station", "Cashier") that employee qualification and
// proficiency are tracked against. Gated to admin/manager by
// middleware.js (ADMIN_ONLY_PREFIXES covers /api/admin).
import db from '../../../../lib/db/index.js';

export const prerender = false;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

export async function GET() {
  const jobs = await db.listJobs();
  return json({ ok: true, jobs });
}

export async function POST(context) {
  const body = await context.request.json().catch(() => null);
  const name = (body && body.name ? String(body.name) : '').trim();
  if (!name) return json({ error: 'A job name is required (e.g. "Shawarma Station").' }, 400);
  const department = body.department ? String(body.department).trim() : null;
  const job = await db.createJob({ name, department });
  return json({ ok: true, job }, 201);
}
