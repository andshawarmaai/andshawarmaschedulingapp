// Records one API call the agent made while answering a chat message.
// Called by the relay for each tool-use the agent did, so the chat UI
// can render confirmation pills ("\u2713 Scheduled Jorge Friday 11-7pm")
// and the manager has a real audit trail of what the agent touched.

import * as chat from '../../../../lib/agentChat.js';

export const prerender = false;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function isStaffOrAbove(role) {
  return role === 'admin' || role === 'manager';
}

export async function POST(context) {
  // The relay posts this for the manager (acting as the API key owner).
  // middleware.js already enforces sign-in via the API key.
  const me = context.locals.user;
  if (!isStaffOrAbove(me.role)) return json({ error: 'Forbidden' }, 403);
  const body = await context.request.json().catch(() => null);
  if (!body || !body.message_id || !body.summary) {
    return json({ error: 'message_id and summary are required.' }, 400);
  }
  // The relay sends user_id from the original message; default to the
  // authenticated caller's id if missing so we never log an orphaned row.
  const user_id = body.user_id || me.id;
  const action = await chat.recordChatAction({
    message_id: body.message_id,
    user_id,
    method: body.method || 'POST',
    endpoint: body.endpoint || '',
    request_body: body.request_body ?? null,
    response_status: body.response_status ?? null,
    response_body: body.response_body ?? null,
    summary: body.summary,
  });
  return json({ ok: true, action });
}

// GET ?message_id=... returns the actions for one assistant message (the
// chat UI uses this when restoring history).
export async function GET(context) {
  const me = context.locals.user;
  if (!isStaffOrAbove(me.role)) return json({ error: 'Forbidden' }, 403);
  const messageId = context.url.searchParams.get('message_id');
  if (!messageId) return json({ error: 'message_id is required.' }, 400);
  const actions = await chat.getChatActionsForMessage(messageId);
  return json({ ok: true, actions });
}
