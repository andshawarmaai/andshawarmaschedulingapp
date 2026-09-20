// Agent-side endpoints — the relay (running wherever the agent process
// lives) calls these with an API key to read pending messages, write
// replies, and log the actions the agent took. The chat UI itself never
// hits these — it only talks to /api/agent/chat/{index,stream}.
//
// Auth: API key (resolved as the user who created the key, with that
// user's role). An agent key must be created by an admin or manager.

import * as chat from '../../../../lib/agentChat.js';

export const prerender = false;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function isStaffOrAbove(role) {
  return role === 'admin' || role === 'manager';
}

// GET /api/admin/agent-chat/pending — list user messages still awaiting
// a reply, oldest first. Relay polls this.
export async function GET(context) {
  const me = context.locals.user;
  if (!isStaffOrAbove(me.role)) return json({ error: 'Forbidden' }, 403);
  const limit = Math.min(Number(context.url.searchParams.get('limit') || 10), 50);
  const pending = await chat.getPendingChatMessages(limit);
  return json({ ok: true, pending });
}
