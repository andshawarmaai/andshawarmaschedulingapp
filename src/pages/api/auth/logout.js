import { SESSION_COOKIE } from '../../../lib/session.js';

export const prerender = false;

export async function POST(context) {
  context.cookies.delete(SESSION_COOKIE, { path: '/' });
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
