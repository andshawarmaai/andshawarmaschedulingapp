import db from '../../../lib/db/index.js';
import { publicUser } from '../../../lib/publicUser.js';

export const prerender = false;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

const ROLES = new Set(['staff', 'manager', 'admin']);

export async function PATCH(context) {
  const { id } = context.params;
  const body = await context.request.json().catch(() => null);
  if (!body) return json({ error: 'Invalid request body.' }, 400);

  const updates = {};
  if (body.display_name !== undefined) updates.display_name = String(body.display_name).trim();
  if (body.phone !== undefined) updates.phone = body.phone ? String(body.phone).trim() : null;
  if (body.email !== undefined) updates.email = body.email ? String(body.email).trim() : null;
  if (body.role !== undefined) {
    if (!ROLES.has(body.role)) return json({ error: 'Invalid role.' }, 400);
    updates.role = body.role;
  }
  if (body.disabled !== undefined) updates.disabled = !!body.disabled;
  if (body.password) {
    if (String(body.password).length < 4) return json({ error: 'Password must be at least 4 characters.' }, 400);
    updates.password = String(body.password);
  }

  const user = await db.updateUser(id, updates);
  if (!user) return json({ error: 'User not found.' }, 404);
  return json({ ok: true, user: publicUser(user) });
}

export async function DELETE(context) {
  const { id } = context.params;
  if (context.locals.user.id === id) {
    return json({ error: 'You cannot delete your own account.' }, 400);
  }
  const existing = await db.getUserById(id);
  if (!existing) return json({ error: 'User not found.' }, 404);
  await db.deleteUser(id);
  return json({ ok: true });
}
