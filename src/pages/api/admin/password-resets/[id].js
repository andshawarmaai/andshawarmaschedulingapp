// Gated to admin/manager by middleware.js (ADMIN_ONLY_PREFIXES covers /api/admin).
import db from '../../../../lib/db/index.js';

export const prerender = false;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

// Marks a request resolved once admin has actually reset the person's
// password (via Manage -> Users -> Edit -> Reset password).
export async function PATCH(context) {
  const { id } = context.params;
  const row = await db.resolvePasswordResetRequest(id, context.locals.user.id);
  if (!row) return json({ error: 'Not found.' }, 404);
  return json({ ok: true, request: row });
}
