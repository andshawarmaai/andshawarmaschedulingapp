// The chat endpoint manager + agents talk through. Self-contained — no
// external relay required.
//
// POST: receive a user message, persist it (status='pending'), then
//       orchestrate the agent end-to-end IN THIS PROCESS:
//         1. Build the context payload (message + history + live state + guide)
//         2. Call AGENT_ENDPOINT (any AI service, see contract below)
//         3. Execute each returned action via this app's own /api/* routes
//            using the caller's session cookie (so audit trail is correct)
//         4. Save the assistant reply (status='complete') + action audit log
//       The chat UI's SSE stream picks up the assistant row as soon as
//       it's written and renders it as it appears.
//
// GET: returns the user's chat history with action logs (for restoring
//      the chat panel on page load).
//
// CONFIG (Vercel environment variables — auto-discovered on each request):
//
//   AGENT_ENDPOINT       — REQUIRED for real agent. URL of the AI service.
//   AGENT_HEADERS_JSON   — optional, JSON string of extra headers,
//                          e.g. '{"Authorization":"Bearer sk-...","x-api-key":"..."}'
//   AGENT_SYSTEM_PROMPT  — optional, default system prompt override
//   AGENT_TIMEOUT_MS     — optional, default 55000 (Vercel's hobby timeout is 60s)
//
// If AGENT_ENDPOINT is NOT set, the chat falls back to STUB MODE: it
// saves the message and replies with a one-line echo + a "what I would
// have done" preview, so the UI still feels alive even with no AI
// configured. README documents the env var.
//
// ENDPOINT CONTRACT:
//
//   POST {AGENT_ENDPOINT}
//   Headers: Content-Type: application/json + (AGENT_HEADERS_JSON merged in)
//   Body: {
//     message:       { id, role, content, user_id, username, display_name },
//     history:       [ { role, content }, ... ],   // last 10 turns
//     state:         { users, shiftTemplates, upcomingShifts },
//     guide:         "...AGENT-TRAINING.md text...",
//     system_prompt: "...optional override..."
//   }
//   Response:
//   {
//     content:  "Reply shown to the manager",
//     actions:  [
//       {
//         method:   "POST",
//         endpoint: "/api/shifts",
//         body:     { user_id, date, start_time, end_time, ... },
//         summary:  "Scheduled Jorge Friday 11-7pm"
//       }
//     ]
//   }

import * as chat from '../../../../lib/agentChat.js';

export const prerender = false;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function isStaffOrAbove(role) {
  return role === 'admin' || role === 'manager';
}

// ─── Config (re-read every request — Vercel env can change without redeploy) ──

function getAgentConfig() {
  const endpoint = process.env.AGENT_ENDPOINT || '';
  let extraHeaders = {};
  if (process.env.AGENT_HEADERS_JSON) {
    try { extraHeaders = JSON.parse(process.env.AGENT_HEADERS_JSON); }
    catch (_) { console.warn('AGENT_HEADERS_JSON is not valid JSON, ignoring'); }
  }
  return {
    endpoint,
    extraHeaders,
    systemPrompt: process.env.AGENT_SYSTEM_PROMPT || '',
    timeoutMs: Number(process.env.AGENT_TIMEOUT_MS || 55000),
  };
}

// ─── AI call (model-agnostic — pass-through to whatever URL is configured) ───

async function callAgent(endpoint, extraHeaders, payload, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...extraHeaders },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      throw new Error(`agent ${endpoint} returned ${r.status}: ${txt.slice(0, 300)}`);
    }
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

// ─── Execute an action the agent returned against this app's own /api/* ───
// We use the CALLER's session cookie (not the agent's API key) so the
// action is attributed to the manager, matching every other write in the
// app. The agent's role is to decide WHAT to do; the manager's role is to
// be the human who actually did it.
async function executeAction(action, callerCookie) {
  const method = action.method || 'POST';
  const url = new URL(action.endpoint, 'http://placeholder').toString().replace(/^http:\/\/placeholder/, '');
  // We use a relative fetch by calling the request handler directly — but
  // it's simpler (and safer) to issue an HTTP request back to our own
  // /api/* endpoints with the caller's cookie preserved.
  const origin = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null;
  const host = origin || (process.env.AGENT_SELF_URL || 'http://localhost:3000');

  const r = await fetch(`${host}${action.endpoint}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Cookie: callerCookie || '',
    },
    body: method === 'GET' ? undefined : JSON.stringify(action.body || {}),
  });
  let body;
  try { body = await r.json(); } catch { body = await r.text().catch(() => ''); }
  return {
    method,
    endpoint: action.endpoint,
    request_body: action.body || {},
    response_status: r.status,
    response_body: body,
    summary: action.summary || `${method} ${action.endpoint}`,
  };
}

// ─── Stub mode: when AGENT_ENDPOINT isn't set, reply with a useful echo ───

function stubReply(userMessage, history, state) {
  const content = userMessage.toLowerCase();
  const users = state.users || [];
  const templates = state.shiftTemplates || [];

  // Cheap name lookup — "schedule Jorge Friday 11-7pm" → Jorge
  const nameMatch = users.find((u) =>
    content.includes(u.username.toLowerCase()) ||
    content.includes(u.display_name.toLowerCase()) ||
    content.includes(u.display_name.split(' ')[0].toLowerCase())
  );

  // Day detection
  const dayMap = { sun: 0, mon: 1, tue: 2, tues: 2, wed: 3, weds: 3, thu: 4, thur: 4, thurs: 4, fri: 5, sat: 6 };
  const dayHit = Object.keys(dayMap).find((k) => content.includes(k));

  // Time detection
  const timeHit = content.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);

  const lines = [
    `✓ I received: "${userMessage}"`,
    ``,
    `_(Stub mode — no AGENT_ENDPOINT configured. To enable real AI, set the AGENT_ENDPOINT environment variable in Vercel project settings. See README for the endpoint contract.)_`,
    ``,
    `Here's what I would do with a real agent:`,
  ];

  if (nameMatch && (dayHit || timeHit)) {
    lines.push(`- Resolve "${nameMatch.display_name}" → user_id ${nameMatch.id}`);
    if (dayHit) lines.push(`- Find the date for "${dayHit}"`);
    if (timeHit) lines.push(`- Extract time "${timeHit[0]}"`);
    lines.push(`- POST /api/shifts with the resolved fields`);
    lines.push(`- Tag the shift with notes describing what the manager asked for`);
  } else if (content.includes('who') || content.includes('show')) {
    lines.push(`- Read GET /api/state to gather users, shifts, templates`);
    lines.push(`- Format a readable summary for the manager`);
  } else {
    lines.push(`- Parse the request (this stub recognizes "schedule [name] [day] [time]" patterns)`);
    lines.push(`- For more complex intents, set AGENT_ENDPOINT to a real AI service`);
  }
  return { content: lines.join('\n'), actions: [] };
}

// ─── POST handler ────────────────────────────────────────────────────────────

export async function POST(context) {
  const me = context.locals.user;
  const body = await context.request.json().catch(() => null);
  if (!body || !body.content || !String(body.content).trim()) {
    return json({ error: 'Message content is required.' }, 400);
  }
  if (!isStaffOrAbove(me.role)) {
    return json({ error: 'Only admins and managers can use the agent chat.' }, 403);
  }

  // 1. Persist the user message
  const userMsg = await chat.createChatMessage({
    user_id: me.id,
    role: 'user',
    content: String(body.content).trim(),
    parent_id: body.parent_id || null,
  });

  // 2. Optimistic stub reply if no agent configured (so the UI isn't dead)
  const cfg = getAgentConfig();
  if (!cfg.endpoint) {
    try {
      const state = await fetch(`${context.url.origin}/api/state`, { headers: { Cookie: context.request.headers.get('cookie') || '' } }).then((r) => r.json()).catch(() => ({}));
      const { content, actions } = stubReply(userMsg.content, [], state);
      const assistant = await chat.createChatMessage({
        user_id: me.id,
        role: 'assistant',
        content,
        parent_id: userMsg.id,
      });
      await chat.updateChatMessageStatus(assistant.id, 'complete');
      for (const a of actions) {
        await chat.recordChatAction({ message_id: assistant.id, user_id: me.id, ...a });
      }
    } catch (err) {
      console.error('stub reply failed:', err);
    }
    return json({ ok: true, message: userMsg }, 201);
  }

  // 3. Real agent: kick off the orchestration asynchronously so the HTTP
  //    response returns immediately. The chat UI's SSE stream watches for
  //    the assistant row to appear.
  const callerCookie = context.request.headers.get('cookie') || '';
  orchestrateReply({
    userMsg,
    userId: me.id,
    username: me.username,
    displayName: me.display_name,
    callerCookie,
    origin: context.url.origin,
    cfg,
  }).catch((err) => console.error('orchestration failed:', err));

  return json({ ok: true, message: userMsg }, 201);
}

// ─── Async orchestration: build context, call agent, execute actions, write reply ───

async function orchestrateReply({ userMsg, userId, username, displayName, callerCookie, origin, cfg }) {
  // Build context
  const [historyResp, state, guide] = await Promise.all([
    fetch(`${origin}/api/agent/chat`, { headers: { Cookie: callerCookie } }).then((r) => r.json()).catch(() => ({ history: [] })),
    fetch(`${origin}/api/state`, { headers: { Cookie: callerCookie } }).then((r) => r.json()).catch(() => ({})),
    fetch(`${origin}/api/agent-guide/markdown`).then((r) => r.text()).catch(() => ''),
  ]);

  const history = (historyResp.history || [])
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ role: m.role, content: (m.content || '').replace(/```json[\s\S]+?```/g, '').trim() }))
    .slice(-10);

  const payload = {
    message: {
      id: userMsg.id,
      role: userMsg.role,
      content: userMsg.content,
      user_id: userId,
      username,
      display_name: displayName,
    },
    history,
    state: {
      users: (state.users || []).map((u) => ({ username: u.username, display_name: u.display_name, role: u.role })),
      shiftTemplates: state.shiftTemplates,
      upcomingShifts: (state.shifts || []).filter((s) => s.date >= new Date().toISOString().slice(0, 10)).slice(0, 30),
    },
    guide,
    system_prompt: cfg.systemPrompt || undefined,
  };

  // Call the agent
  let agentResult;
  try {
    agentResult = await callAgent(cfg.endpoint, cfg.extraHeaders, payload, cfg.timeoutMs);
  } catch (err) {
    // Save an error assistant row so the UI shows something
    const assistant = await chat.createChatMessage({
      user_id: userId,
      role: 'assistant',
      content: `The agent at ${cfg.endpoint} failed: ${err.message}`,
      parent_id: userMsg.id,
    });
    await chat.updateChatMessageStatus(assistant.id, 'error');
    return;
  }

  const { content, actions = [] } = agentResult;

  // Execute each action via this app's own /api/* routes (using the
  // caller's session cookie so audit attribution is correct).
  const executed = [];
  for (const action of actions) {
    if (!action || !action.endpoint) continue;
    const result = await executeAction(action, callerCookie);
    executed.push(result);
  }

  // Write the assistant reply + action log
  const assistant = await chat.createChatMessage({
    user_id: userId,
    role: 'assistant',
    content: content || '(no reply from agent)',
    parent_id: userMsg.id,
  });
  await chat.updateChatMessageStatus(assistant.id, 'complete');
  for (const a of executed) {
    await chat.recordChatAction({ message_id: assistant.id, user_id: userId, ...a });
  }
}

// ─── GET handler (history + actions for the panel) ────────────────────────────

export async function GET(context) {
  const me = context.locals.user;
  if (!isStaffOrAbove(me.role)) return json({ error: 'Forbidden' }, 403);
  const history = await chat.getChatHistory(me.id, 50);
  const ids = history.filter((m) => m.role === 'assistant').map((m) => m.id);
  const actions = {};
  for (const id of ids) actions[id] = await chat.getChatActionsForMessage(id);
  // Include the resolved user for each message so the panel can render
  // "You: ..." vs "Hermes: ..." correctly even when seeded via the API
  // key (which acts as the manager, so role='assistant' but the message
  // is from a real person).
  return json({ ok: true, history, actions, me: { id: me.id, display_name: me.display_name } });
}
