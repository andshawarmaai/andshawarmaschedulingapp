import bcrypt from 'bcryptjs';
import db from '../../../lib/db/index.js';
import { createSessionToken, SESSION_COOKIE, SESSION_MAX_AGE } from '../../../lib/session.js';

export const prerender = false;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function publicUser(u) {
  return {
    id: u.id,
    username: u.username,
    display_name: u.display_name,
    role: u.role,
    email: u.email,
    phone: u.phone,
  };
}

export async function POST(context) {
  const body = await context.request.json().catch(() => null);
  const username = (body && body.username ? String(body.username) : '').trim();
  const password = body && body.password ? String(body.password) : '';

  if (!username || !password) {
    return json({ error: 'Username and password are required.' }, 400);
  }

  const user = await db.getUserByUsername(username);
  if (!user) {
    return json({ error: 'Incorrect username or password.' }, 401);
  }
  if (user.disabled) {
    return json({ error: 'This account has been disabled. Contact an admin.' }, 403);
  }

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) {
    return json({ error: 'Incorrect username or password.' }, 401);
  }

  const token = createSessionToken(user);
  context.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: import.meta.env.PROD,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_MAX_AGE,
  });

  return json({ ok: true, user: publicUser(user) });
}
