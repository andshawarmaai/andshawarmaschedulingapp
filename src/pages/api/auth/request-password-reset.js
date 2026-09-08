// Public (no session required — reachable from the login screen before
// anyone is signed in). There's no email sender configured for this app,
// so a reset "request" is filed for an admin to see and act on manually,
// the same way any other pending item shows up.
//
// Deliberately returns the same generic response whether or not the
// username exists, so this can't be used to enumerate valid usernames.
import db from '../../../lib/db/index.js';

export const prerender = false;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

export async function POST(context) {
  const body = await context.request.json().catch(() => null);
  const username = (body && body.username ? String(body.username) : '').trim();
  if (!username) {
    return json({ error: 'Enter your username first.' }, 400);
  }

  const user = await db.getUserByUsername(username);
  if (user && !user.disabled) {
    await db.createPasswordResetRequest(user.id);
  }

  // Same message either way — see note above.
  return json({ ok: true, message: 'If that account exists, an admin has been notified and will reset your password.' });
}
