// Gated to admin/manager by middleware.js (ADMIN_ONLY_PREFIXES covers
// /api/admin), but tiers are admin-only per product decision — a manager
// should never even learn tiers exist — so every handler here narrows
// further to role === 'admin'.
import db from '../../../../lib/db/index.js';

export const prerender = false;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

// Accepts a raw body value for one of the four limit fields: empty/blank
// means "no cap" (null), otherwise it must be a non-negative integer.
function parseLimit(value) {
  if (value === null || value === undefined || value === '') return { ok: true, value: null };
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) return { ok: false };
  return { ok: true, value: n };
}

const LIMIT_FIELDS = ['max_shifts_per_month', 'max_weekend_shifts_per_month', 'max_days_off_per_month', 'max_weekend_days_off_per_month'];

export async function POST(context) {
  const me = context.locals.user;
  if (me.role !== 'admin') return json({ error: 'Only admins can manage tiers.' }, 403);

  const body = await context.request.json().catch(() => null);
  const name = (body && body.name ? String(body.name) : '').trim();
  if (!name) return json({ error: 'A tier name is required (e.g. "Tier 1").' }, 400);

  const limits = {};
  for (const field of LIMIT_FIELDS) {
    const parsed = parseLimit(body && body[field]);
    if (!parsed.ok) return json({ error: `${field} must be a whole number ≥ 0, or blank for no limit.` }, 400);
    limits[field] = parsed.value;
  }

  const tier = await db.createTier({ name, ...limits });
  return json({ ok: true, tier }, 201);
}
