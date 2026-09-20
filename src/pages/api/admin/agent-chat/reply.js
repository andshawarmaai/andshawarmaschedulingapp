// The relay posts the agent's assistant reply here. The body is the
// existing user message id, content (the agent's full response), and an
// optional streaming partial update so the chat UI sees content land
// token-by-token via SSE.
//
// The relay uses an API key (in middleware.js's `resolveApiKeyUser`) so
// this endpoint never needs a session cookie. The reply is attributed to
// the API key's owner (a real manager), matching every other write in the
// app.

import * as chat from '../../../../lib/agentChat.js';

export const prerender = false;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function isStaffOrAbove(role) {
  return role === 'admin' || role === 'manager';
}

export async function POST(context) {
  const me = context.locals.user;
  if (!isStaffOrAbove(me.role)) return json({ error: 'Forbidden' }, 403);
  const body = await context.request.json().catch(() => null);
  if (!body || !body.user_message_id || !body.content) {
    return json({ error: 'user_message_id and content are required.' }, 400);
  }
  if (!['streaming', 'complete', 'error'].includes(body.status)) {
    return json({ error: 'status must be streaming, complete, or error.' }, 400);
  }
  const parent = await chat.getChatMessage(body.user_message_id);
  if (!parent) return json({ error: 'User message not found.' }, 404);
  if (parent.role !== 'user') return json({ error: 'Parent message is not a user message.' }, 400);

  // Idempotent: if an assistant reply already exists for this user
  // message, update it instead of creating a new one. Lets the relay
  // recover from crashes mid-stream without duplicating.
  const history = await chat.getChatHistory(parent.user_id, 5);
  let assistant = history.find((m) => m.role === 'assistant' && m.parent_id === parent.id);

  if (!assistant) {
    assistant = await chat.createChatMessage({
      user_id: parent.user_id,
      role: 'assistant',
      content: body.content,
      parent_id: parent.id,
    });
    await chat.updateChatMessageStatus(assistant.id, body.status);
  } else {
    await chat.updateChatMessageStatus(assistant.id, body.status, body.content);
  }

  return json({ ok: true, message: assistant });
}
