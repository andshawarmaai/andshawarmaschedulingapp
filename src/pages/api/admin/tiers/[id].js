import db from '../../../../lib/db/index.js';

export const prerender = false;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function parseLimit(value) {
  if (value === null || value === undefined || value === '') return { ok: true, value: null };
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) return { ok: false };
  return { ok: true, value: n };
}

const LIMIT_FIELDS = ['max_shifts_per_month', 'max_weekend_shifts_per_month', 'max_days_off_per_month', 'max_weekend_days_off_per_month'];

export async function PATCH(context) {
  const me = context.locals.user;
  if (me.role !== 'admin') return json({ error: 'Only admins can manage tiers.' }, 403);

  const { id } = context.params;
  const body = await context.request.json().catch(() => null);
  if (!body) return json({ error: 'Invalid request body.' }, 400);

  const updates = {};
  if (body.name !== undefined) {
    const name = String(body.name).trim();
    if (!name) return json({ error: 'Tier name cannot be blank.' }, 400);
    updates.name = name;
  }
  for (const field of LIMIT_FIELDS) {
    if (body[field] === undefined) continue;
    const parsed = parseLimit(body[field]);
    if (!parsed.ok) return json({ error: `${field} must be a whole number ≥ 0, or blank for no limit.` }, 400);
    updates[field] = parsed.value;
  }

  const tier = await db.updateTier(id, updates);
  if (!tier) return json({ error: 'Tier not found.' }, 404);
  return json({ ok: true, tier });
}

export async function DELETE(context) {
  const me = context.locals.user;
  if (me.role !== 'admin') return json({ error: 'Only admins can manage tiers.' }, 403);

  const { id } = context.params;
  await db.deleteTier(id);
  return json({ ok: true });
}
