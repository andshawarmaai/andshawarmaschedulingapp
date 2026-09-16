import bcrypt from 'bcryptjs';
import db from '../../lib/db/index.js';
import { publicUser } from '../../lib/publicUser.js';

export const prerender = false;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

// Self-service profile updates — deliberately separate from the
// admin/manager-only /api/users/[id] (which can also touch role, disabled,
// tier_id, and anyone's row). This route only ever touches the CALLER's
// own contact info and password, and isn't under an ADMIN_ONLY_PREFIX in
// middleware.js, so any signed-in user (staff included) can reach it.
export async function PATCH(context) {
  const me = context.locals.user;
  const body = await context.request.json().catch(() => null);
  if (!body) return json({ error: 'Invalid request body.' }, 400);

  const updates = {};
  if (body.email !== undefined) updates.email = body.email ? String(body.email).trim() : null;
  if (body.phone !== undefined) updates.phone = body.phone ? String(body.phone).trim() : null;

  if (body.new_password) {
    const current = await db.getUserById(me.id);
    if (!current) return json({ error: 'User not found.' }, 404);
    const currentPassword = body.current_password ? String(body.current_password) : '';
    const ok = currentPassword && await bcrypt.compare(currentPassword, current.password_hash);
    if (!ok) return json({ error: 'Current password is incorrect.' }, 400);
    if (String(body.new_password).length < 4) return json({ error: 'New password must be at least 4 characters.' }, 400);
    updates.password = String(body.new_password);
  }

  if (Object.keys(updates).length === 0) return json({ error: 'Nothing to update.' }, 400);

  const user = await db.updateUser(me.id, updates);
  if (!user) return json({ error: 'User not found.' }, 404);
  return json({ ok: true, user: publicUser(user) });
}
