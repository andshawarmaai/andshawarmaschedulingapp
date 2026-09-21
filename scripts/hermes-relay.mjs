#!/usr/bin/env node
// Hermes chat relay — model-agnostic bridge between the Vercel app's chat
// panel and an external AI agent.
//
// What it does:
//
//   1. Every POLL_INTERVAL_MS, GET /api/admin/agent-chat/pending
//      (with the agent's API key) — pulls user messages with status='pending'.
//   2. For each pending message, builds a context payload (the user's
//      message + chat history + live DB state + the agent training doc)
//      and POSTs it to AGENT_ENDPOINT (a configurable URL).
//   3. The endpoint can be any AI service — Claude, OpenAI, a local LLM,
//      another Hermes session, a webhook into any agent framework — as
//      long as it returns { content: string, actions: [{method, endpoint,
//      body, summary}] }. The relay doesn't care who or what is on the
//      other side.
//   4. The relay executes each returned action by calling the app's own
//      /api/* endpoints (with the agent's API key) — this is what makes
//      the agent's reply actually DO something rather than just describe.
//   5. The relay POSTs /api/admin/agent-chat/reply with the content
//      and POSTs /api/admin/agent-chat/action for each audit-log entry.
//      The chat UI sees the assistant row appear with the
//      "✓ Scheduled Jorge..." confirmation pills.
//
// Config (env vars):
//
//   AGENT_API_KEY      — the agent's API key for the Vercel app
//   API_BASE           — base URL of the Vercel app
//   AGENT_ENDPOINT     — URL of the AI agent (any service, see contract below)
//   AGENT_HEADERS      — optional extra headers as JSON (e.g. {"Authorization":"Bearer sk-..."})
//   AGENT_TIMEOUT_MS   — default 60000
//   POLL_INTERVAL_MS   — default 1500
//
// Endpoint contract:
//
//   POST {AGENT_ENDPOINT}
//   Headers: AGENT_HEADERS + Content-Type: application/json
//   Body: {
//     message:      { id, role, content, user_id, username, display_name },
//     history:      [ { role, content }, ... ],   // last 10 turns, user/assistant only
//     state:        { ...full GET /api/state response... },
//     guide:        "...full AGENT-TRAINING.md contents...",
//     system_prompt:"...optional explicit instructions..."
//   }
//
//   Response:
//   {
//     content:  "Your reply shown to the manager in the chat",
//     actions:  [
//       {
//         method: "POST",
//         endpoint: "/api/shifts",
//         body: { user_id: "...", date: "...", ... },
//         summary: "Scheduled Jorge Friday 11-7pm"
//       }
//     ]
//   }

import process from 'node:process';

const API_BASE = process.env.API_BASE || 'https://andshawarmaschedulingapp.vercel.app';
const AGENT_API_KEY = process.env.AGENT_API_KEY || 'shwrm_qzxsVhmGn8l0rU8a6EApj356JfubA_fc';
const AGENT_ENDPOINT = process.env.AGENT_ENDPOINT || ''; // REQUIRED: where the AI lives
const AGENT_TIMEOUT_MS = Number(process.env.AGENT_TIMEOUT_MS || 60000);
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 1500);
const SYSTEM_PROMPT = process.env.AGENT_SYSTEM_PROMPT || '';

let extraHeaders = {};
try { extraHeaders = JSON.parse(process.env.AGENT_HEADERS || '{}'); } catch (_) {
  console.warn('AGENT_HEADERS is not valid JSON, ignoring');
}

if (!AGENT_ENDPOINT) {
  console.error('AGENT_ENDPOINT is required. Set it to the URL of your AI service.');
  console.error('Example: AGENT_ENDPOINT=https://api.anthropic.com/v1/messages AGENT_HEADERS=\'{"x-api-key":"sk-...","anthropic-version":"2023-06-01"}\'');
  console.error('Or:       AGENT_ENDPOINT=https://your-hermes-webhook.example.com/chat');
  process.exit(1);
}

const appHeaders = {
  'Authorization': `Bearer ${AGENT_API_KEY}`,
  'Content-Type': 'application/json',
};

const seen = new Set(); // dedupe within this process

async function appApi(path, init = {}) {
  const r = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { ...appHeaders, ...(init.headers || {}) },
  });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`${init.method || 'GET'} ${path} → ${r.status} ${txt.slice(0, 200)}`);
  }
  return r.json();
}

// Fetch the agent training guide ONCE at startup — it's static text
// (~17KB markdown) that the AI needs to know what endpoints exist.
let guideCache = null;
async function getGuide() {
  if (guideCache) return guideCache;
  try {
    const r = await fetch(`${API_BASE}/api/agent-guide/markdown`);
    if (r.ok) guideCache = await r.text();
    else guideCache = '(agent guide unavailable)';
  } catch (_) {
    guideCache = '(agent guide unavailable)';
  }
  return guideCache;
}

// Call the configured AI endpoint with the full context. Pure pass-through —
// this relay doesn't know or care what model is on the other end.
async function callAgent(payload) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AGENT_TIMEOUT_MS);
  try {
    const r = await fetch(AGENT_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...extraHeaders },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      throw new Error(`agent returned ${r.status}: ${txt.slice(0, 300)}`);
    }
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

// Execute an action the agent returned by calling the app's own API.
// Auth uses the agent's API key — the agent is acting as itself.
async function executeAction(action, messageId, userId) {
  try {
    const result = await appApi(action.endpoint, {
      method: action.method || 'POST',
      body: JSON.stringify(action.body || {}),
    });
    return {
      method: action.method || 'POST',
      endpoint: action.endpoint,
      request_body: action.body || {},
      response_status: 200,
      response_body: result,
      summary: action.summary || `${action.method || 'POST'} ${action.endpoint}`,
    };
  } catch (err) {
    return {
      method: action.method || 'POST',
      endpoint: action.endpoint,
      request_body: action.body || {},
      response_status: 500,
      response_body: { error: String(err.message || err) },
      summary: `FAILED: ${action.summary || action.endpoint}`,
    };
  }
}

async function processMessage(msg) {
  console.log(`[${new Date().toISOString()}] ${msg.username}: "${msg.content.slice(0, 80)}"`);

  // Build context
  const [historyResp, state, guide] = await Promise.all([
    appApi('/api/agent/chat').catch(() => ({ history: [] })),
    appApi('/api/state').catch(() => ({})),
    getGuide(),
  ]);

  // Don't pollute history with action JSON blocks from previous turns —
  // strip any ```json``` blocks from assistant messages.
  const history = (historyResp.history || [])
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ role: m.role, content: (m.content || '').replace(/```json[\s\S]+?```/g, '').trim() }))
    .slice(-10);

  const payload = {
    message: {
      id: msg.id,
      role: msg.role,
      content: msg.content,
      user_id: msg.user_id,
      username: msg.username,
      display_name: msg.display_name,
    },
    history,
    state: {
      users: (state.users || []).map((u) => ({ username: u.username, display_name: u.display_name, role: u.role })),
      shiftTemplates: state.shiftTemplates,
      upcomingShifts: (state.shifts || []).filter((s) => s.date >= new Date().toISOString().slice(0, 10)).slice(0, 30),
    },
    guide,
    system_prompt: SYSTEM_PROMPT || undefined,
  };

  // Call the AI
  const { content, actions = [] } = await callAgent(payload);

  // Execute each action
  const executedActions = [];
  for (const action of actions) {
    if (!action || !action.endpoint) continue;
    console.log(`  → ${action.method || 'POST'} ${action.endpoint} (${action.summary || ''})`);
    const result = await executeAction(action, msg.id, msg.user_id);
    executedActions.push(result);
    if (result.response_status >= 400) {
      console.log(`    ✗ ${result.summary}`);
    }
  }

  // Write the reply
  await appApi('/api/admin/agent-chat/reply', {
    method: 'POST',
    body: JSON.stringify({
      user_message_id: msg.id,
      content: content || '(no reply)',
      status: 'complete',
    }),
  });

  // Log each action
  for (const a of executedActions) {
    await appApi('/api/admin/agent-chat/action', {
      method: 'POST',
      body: JSON.stringify({
        message_id: msg.id,
        user_id: msg.user_id,
        ...a,
      }),
    }).catch((e) => console.error('  action log failed:', e.message));
  }

  console.log(`  ✓ replied (${(content || '').length} chars), ${executedActions.length} action(s)`);
}

async function tick() {
  let pending;
  try {
    pending = (await appApi('/api/admin/agent-chat/pending?limit=5')).pending || [];
  } catch (err) {
    console.error(`[${new Date().toISOString()}] poll error:`, err.message);
    return;
  }
  for (const msg of pending) {
    if (seen.has(msg.id)) continue;
    seen.add(msg.id);
    try {
      await processMessage(msg);
    } catch (err) {
      console.error(`  ✗ FAILED ${msg.id}:`, err.message);
      try {
        await appApi('/api/admin/agent-chat/reply', {
          method: 'POST',
          body: JSON.stringify({
            user_message_id: msg.id,
            content: `Sorry, the agent failed: ${err.message}`,
            status: 'error',
          }),
        });
      } catch (_) { /* */ }
    }
  }
}

console.log(`hermes-relay`);
console.log(`  api:   ${API_BASE}`);
console.log(`  agent: ${AGENT_ENDPOINT}`);
console.log(`  poll:  ${POLL_INTERVAL_MS}ms`);
console.log(`  timeout: ${AGENT_TIMEOUT_MS}ms`);
setInterval(tick, POLL_INTERVAL_MS);
tick();

process.on('SIGINT', () => { console.log('\nshutting down'); process.exit(0); });
process.on('SIGTERM', () => { console.log('\nshutting down'); process.exit(0); });
