// Gated to admin/manager by middleware.js (ADMIN_ONLY_PREFIXES covers /api/admin).
import db from '../../../../lib/db/index.js';

export const prerender = false;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

export async function DELETE(context) {
  const { id } = context.params;
  await db.revokeApiKey(id);
  return json({ ok: true });
}
