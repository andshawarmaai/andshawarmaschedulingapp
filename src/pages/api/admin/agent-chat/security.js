// GET /api/admin/agent-chat/security — chat security log for the Manage
// page's "Chat security log" panel. Backed by the chat_security_log table
// (db/schema.sql) and src/lib/agentChat.js's listChatSecurityEvents,
// which already existed on both DB backends — this route was the only
// missing piece wiring the UI to them.
//
// Nothing currently writes to this table (the orchestrator in
// /api/agent/chat/index.js doesn't call createChatSecurityEvent yet), so
// this will legitimately return an empty list until that detection logic
// is added — the UI's "No security events yet" empty state already
// covers that honestly rather than looking broken.

import * as chat from '../../../../lib/agentChat.js';

export const prerender = false;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

export async function GET(context) {
  const me = context.locals.user;
  if (me.role !== 'admin' && me.role !== 'manager') return json({ error: 'Forbidden' }, 403);
  const limit = Math.min(Number(context.url.searchParams.get('limit') || 200), 500);
  const events = await chat.listChatSecurityEvents({ limit });
  return json({ ok: true, events });
}
