import { SESSION_COOKIE } from '../../../lib/session.js';
import * as chat from '../../../lib/agentChat.js';

export const prerender = false;

export async function POST(context) {
  // Capture the user id BEFORE clearing the cookie so we can wipe their
  // chat history on the way out — keeping the DB free of stale rows.
  const userId = context.locals.user && context.locals.user.id;
  context.cookies.delete(SESSION_COOKIE, { path: '/' });
  if (userId) {
    try {
      await chat.clearChatForUser(userId);
    } catch (_) {
      // Non-fatal — never block sign-out on a chat cleanup failure.
    }
  }
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
