import db from '../../../../lib/db/index.js';

export const prerender = false;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

export async function PATCH(context) {
  const { id } = context.params;
  const body = await context.request.json().catch(() => null);
  if (!body) return json({ error: 'Invalid request body.' }, 400);

  const updates = {};
  if (body.name !== undefined) {
    const name = String(body.name).trim();
    if (!name) return json({ error: 'Job name cannot be blank.' }, 400);
    updates.name = name;
  }
  if (body.department !== undefined) updates.department = body.department ? String(body.department).trim() : null;
  if (body.disabled !== undefined) updates.disabled = !!body.disabled;

  const job = await db.updateJob(id, updates);
  if (!job) return json({ error: 'Job not found.' }, 404);
  return json({ ok: true, job });
}

export async function DELETE(context) {
  const { id } = context.params;
  await db.deleteJob(id);
  return json({ ok: true });
}
