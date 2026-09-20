// Send a message to the Hermes agent. The chat UI POSTs the user's natural-
// language request here; the message is persisted to agent_chat_messages
// with status='pending' and the role='user'. The agent (a long-running
// process that polls this table) picks it up, acts, and writes a paired
// role='assistant' reply back, updating its status as it streams content
// in. The chat UI's SSE stream (/api/agent/chat/stream) watches that row
// and renders each new status='streaming' update as it arrives.
//
// Auth: middleware.js already enforces any signed-in user; we add a role
// check here because only staff-or-above should be driving schedule
// changes from chat — exactly the same gate /api/admin/* uses.

import * as chat from '../../../../lib/agentChat.js';

export const prerender = false;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

export async function POST(context) {
  const me = context.locals.user;
  const body = await context.request.json().catch(() => null);
  if (!body || !body.content || !String(body.content).trim()) {
    return json({ error: 'Message content is required.' }, 400);
  }
  if (me.role !== 'admin' && me.role !== 'manager') {
    return json({ error: 'Only admins and managers can use the agent chat.' }, 403);
  }

  const message = await chat.createChatMessage({
    user_id: me.id,
    role: 'user',
    content: String(body.content).trim(),
    parent_id: body.parent_id || null,
  });

  return json({ ok: true, message }, 201);
}

// GET returns the most recent N messages for the caller, so the chat panel
// can restore history on page load.
export async function GET(context) {
  const me = context.locals.user;
  if (me.role !== 'admin' && me.role !== 'manager') {
    return json({ error: 'Forbidden' }, 403);
  }
  const history = await chat.getChatHistory(me.id, 50);
  // Also fetch actions for any assistant messages in the history so the UI
  // can render "✓ Scheduled Jorge Friday 11-7pm (shift_id abc)" pills.
  const messageIds = history.filter((m) => m.role === 'assistant').map((m) => m.id);
  const actions = {};
  for (const id of messageIds) {
    actions[id] = await chat.getChatActionsForMessage(id);
  }
  return json({ ok: true, history, actions });
}
