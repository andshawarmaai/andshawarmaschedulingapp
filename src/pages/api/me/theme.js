// Per-user light/dark preference. GET reads it; PUT persists it.
// Unauthenticated callers (the login page) get no theme in the
// response — ThemeToggle falls back to localStorage / system pref.

import db from '../../../lib/db/index.js';

export const prerender = false;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

export async function GET(context) {
  const me = context.locals && context.locals.user;
  if (!me) return json({ theme_pref: null });
  const u = await db.getUserById(me.id);
  return json({ theme_pref: u ? u.theme_pref || null : null });
}

export async function PUT(context) {
  const me = context.locals && context.locals.user;
  if (!me) return json({ error: 'Sign in to save a theme preference.' }, 401);
  const body = await context.request.json().catch(() => null);
  if (!body) return json({ error: 'Invalid body.' }, 400);
  const v = body.theme_pref;
  if (v !== null && v !== 'light' && v !== 'dark') {
    return json({ error: 'theme_pref must be "light", "dark", or null.' }, 400);
  }
  const updated = await db.updateUser(me.id, { theme_pref: v });
  return json({ ok: true, theme_pref: updated ? updated.theme_pref || null : null });
}
