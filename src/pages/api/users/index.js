// Gated to admin/manager by middleware.js (ADMIN_ONLY_PREFIXES covers /api/users).
import db from '../../../lib/db/index.js';
import { publicUser } from '../../../lib/publicUser.js';

export const prerender = false;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

const ROLES = new Set(['staff', 'manager', 'admin']);

export async function POST(context) {
  const body = await context.request.json().catch(() => null);
  const username = (body && body.username ? String(body.username) : '').trim();
  const password = body && body.password ? String(body.password) : '';
  const display_name = (body && body.display_name ? String(body.display_name) : '').trim();
  const role = body && ROLES.has(body.role) ? body.role : 'staff';
  const email = body && body.email ? String(body.email).trim() : null;
  const phone = body && body.phone ? String(body.phone).trim() : null;

  if (!username || !password || !display_name) {
    return json({ error: 'Name, username, and password are required.' }, 400);
  }
  if (password.length < 4) {
    return json({ error: 'Password must be at least 4 characters.' }, 400);
  }

  try {
    const user = await db.createUser({ username, password, display_name, role, email, phone });
    return json({ ok: true, user: publicUser(user) }, 201);
  } catch (err) {
    if (err && err.code === 'DUPLICATE') {
      return json({ error: 'That username is already taken.' }, 409);
    }
    return json({ error: 'Could not create user.' }, 500);
  }
}
