// Server-Sent Events stream for the agent chat. The chat UI opens one of
// these per page load and keeps it open. We poll agent_chat_messages every
// ~600ms for new assistant rows (paired to the caller's most recent
// 'user' message) and stream status/content changes to the browser.
//
// Why not WebSockets: SSE works over plain HTTP, survives the Vercel
// serverless-function-cold-start model (a fresh function instance picks up
// where the last one left off by re-reading the table), and needs no extra
// infra. Latency is ~1-2s per chunk, which is fine for chat.
//
// Auth: same gate as POST /api/agent/chat — staff-or-above only.

import * as chat from '../../../../lib/agentChat.js';

export const prerender = false;

function isStaffOrAbove(role) {
  return role === 'admin' || role === 'manager';
}

export async function GET(context) {
  const me = context.locals.user;
  if (!isStaffOrAbove(me.role)) {
    return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
  }

  const encoder = new TextEncoder();
  let lastAssistantId = null;
  let lastSeenContent = '';
  let lastSeenStatus = '';
  let isAlive = true;

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event, data) => {
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch (_) { /* client disconnected */ }
      };

      // Initial snapshot so the page knows what's already there
      send('hello', { user_id: me.id, ts: Date.now() });

      const tick = async () => {
        if (!isAlive) return;
        try {
          // Find the most recent assistant message for this user.
          const history = await chat.getChatHistory(me.id, 5);
          const lastAssistant = history.filter((m) => m.role === 'assistant').slice(-1)[0];
          if (lastAssistant) {
            if (lastAssistant.id !== lastAssistantId) {
              lastAssistantId = lastAssistant.id;
              lastSeenContent = '';
              lastSeenStatus = '';
              send('new', { id: lastAssistant.id });
            }
            if (lastAssistant.status !== lastSeenStatus) {
              lastSeenStatus = lastAssistant.status;
              send('status', { id: lastAssistant.id, status: lastAssistant.status });
            }
            if (lastAssistant.content !== lastSeenContent) {
              lastSeenContent = lastAssistant.content;
              send('token', { id: lastAssistant.id, content: lastAssistant.content });
            }
            if (lastAssistant.status === 'complete' || lastAssistant.status === 'error') {
              // Pull the action audit log so the UI can render confirmation pills
              const actions = await chat.getChatActionsForMessage(lastAssistant.id);
              send('done', { id: lastAssistant.id, status: lastAssistant.status, actions });
              // Reset so we don't re-send the same 'done' over and over.
              lastAssistantId = null;
            }
          }
        } catch (err) {
          send('error', { message: String(err && err.message || err) });
        }
      };

      // Initial tick + interval. ~600ms keeps token updates feeling live
      // without hammering the DB.
      await tick();
      const interval = setInterval(tick, 600);

      // Keep the connection open. Vercel's edge will close it after ~5min
      // on the hobby plan; the client reconnects automatically on close.
      const keepAlive = setInterval(() => {
        try { controller.enqueue(encoder.encode(`: keep-alive\n\n`)); } catch (_) {}
      }, 15000);

      // Cleanup if the client disconnects
      context.request.signal.addEventListener('abort', () => {
        isAlive = false;
        clearInterval(interval);
        clearInterval(keepAlive);
        try { controller.close(); } catch (_) {}
      });
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
