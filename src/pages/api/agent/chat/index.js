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
import { getActiveProviderConfig } from '../../admin/settings/ai.js';

export const prerender = false;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function isStaffOrAbove(role) {
  return role === 'admin' || role === 'manager';
}

// ─── Provider-driven agent call ─────────────────────────────────────────────
// The chat orchestrator now reads the AI provider + key from the Settings
// panel (encrypted in app_settings), not from env vars. Adding a new
// provider means adding one entry to PROVIDERS in /api/admin/settings/ai.js.

const SYSTEM_PROMPT = `You are the scheduling assistant inside the &Shawarma scheduling app. You talk to a restaurant manager or owner who is NOT technical. They will speak casually ("schedule jorge friday 11 to 7", "swap john and bhanu saturday", "who's working thursday lunch") and expect you to just figure it out and do it.

VOICE & FORMAT RULES — these matter:
- Talk like a helpful coworker, not a tech demo. No bullet lists of API endpoints. No "POST /api/shifts". No "resolved user_id".
- Keep replies short. 1-3 sentences for simple actions, a small paragraph max for anything else.
- When you did something, say so plainly: "Done — Jorge's on Friday 4-10pm." or "Posted Adnan's Saturday shift for swap."
- When you're not sure who they mean (e.g. two people share a first name), ask ONE short question.
- If the time doesn't match any shift template, propose the closest template: "I don't have a 4-10pm shift on the books — closest is the Late Mid block 11:30-10:30pm. Want me to use that, or keep 4-10 as a one-off?"
- Never mention API keys, JSON blocks, deployments, environment variables, code paths, or any backend plumbing. The manager doesn't care and shouldn't see it.
- Never approve or deny a pending request — say "ready for review in the Schedule Builder" if needed.
- Use names how the manager uses them. If they say "Jorge", say "Jorge", not his username.

When you want to actually DO something in the schedule, return a JSON block like this (the orchestrator will execute it for you; the manager never sees this):

\`\`\`json
{
  "actions": [
    { "method": "POST", "endpoint": "/api/shifts", "body": {"user_id":"...","date":"YYYY-MM-DD","start_time":"HH:MM","end_time":"HH:MM"}, "summary": "one short sentence describing what you did" }
  ]
}
\`\`\`

Followed by your plain-English reply (NOT inside the JSON block). The summary strings will appear as small confirmation pills in the chat, so make them human.`;

// ─── Action execution: re-call this app's own /api/* with the caller's cookie ───

async function executeAction(action, callerCookie) {
  const method = action.method || 'POST';
  const origin = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : (process.env.AGENT_SELF_URL || 'http://localhost:3000');
  const r = await fetch(`${origin}${action.endpoint}`, {
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

  const lines = [`Got it — you said: "${userMessage}".`];

  if (nameMatch && (dayHit || timeHit)) {
    lines.push(`\nI'd put ${nameMatch.display_name} on`);
    if (dayHit) lines.push(`• ${dayHit.charAt(0).toUpperCase()}${dayHit.slice(1)}day`);
    if (timeHit) lines.push(`• at ${timeHit[0]}`);
    lines.push(`\nBut I'm running in test mode right now — no AI connected yet, so I can't actually save the change. Your manager (or whoever set this app up) needs to plug an AI into the chat settings.`);
    lines.push(`\nIn the meantime you can add the shift directly on the calendar by clicking the day and using the + button.`);
  } else if (content.includes('who') || content.includes('show') || content.includes('working')) {
    lines.push(`\nI'm in test mode so I can't look anything up yet. Once an AI is connected I'll be able to tell you who's working when, summarize the day, and so on.`);
    lines.push(`\nFor now, scroll the calendar above to see who's scheduled.`);
  } else if (content.includes('remove') || content.includes('delete') || content.includes('cancel')) {
    lines.push(`\nI'd handle that for you normally, but I'm in test mode. To remove a shift: hover the colored block on the calendar, right-click, pick Delete.`);
  } else if (content.includes('swap')) {
    lines.push(`\nI'd post that for swap, but I'm in test mode. For now: go to the Shift Swap page in the sidebar.`);
  } else if (content.includes('template') || content.includes('coverage') || content.includes('open')) {
    lines.push(`\nI'm in test mode — I can't edit shift templates yet. There's a Shift Templates panel at the bottom of this page you can use directly.`);
  } else {
    lines.push(`\nI'm in test mode so I can't actually do anything yet. Once your developer wires up an AI I'll be able to:`);
    lines.push(`• Add, move, or remove shifts`);
    lines.push(`• Show who's working when`);
    lines.push(`• Post shifts for swap, mark time off, manage templates`);
    lines.push(`\nFor now, just describe what you want and I'll get to it once I'm fully set up. Your manager knows what's needed.`);
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

  // 2. Optimistic stub reply if no provider is configured (Settings panel
  //    hasn't been filled in). Lets the UI show something while the admin
  //    sets up their AI key.
  const cfg = await getActiveProviderConfig();
  if (!cfg) {
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

  // Call the configured provider with the chat context. The provider
  // returns plain text; we extract any JSON action block from it (same
  // contract the old relay used) so the existing executeAction pipeline
  // keeps working unchanged.
  let assistantText = '';
  try {
    const messages = [
      ...history,
      { role: 'user', content: userMsg.content },
    ];
    assistantText = await cfg.provider.chat(cfg.api_key, {
      model: cfg.model,
      system: SYSTEM_PROMPT + '\n\n' + guide,
      messages,
      max_tokens: 2048,
    });
  } catch (err) {
    const assistant = await chat.createChatMessage({
      user_id: userId,
      role: 'assistant',
      content: `The ${cfg.provider.label || cfg.provider} agent failed: ${err.message}`,
      parent_id: userMsg.id,
    });
    await chat.updateChatMessageStatus(assistant.id, 'error');
    return;
  }

  // Extract any JSON action block from the assistant's reply. The provider
  // (Claude/OpenAI/MiniMax) just returns plain text following the system
  // prompt's instructions: a ```json``` block with the actions, then the
  // user-facing reply. We split them so the action JSON never reaches the
  // chat panel.
  let content = assistantText || '';
  let actions = [];
  const m = content.match(/```json\s*([\s\S]+?)\s*```/);
  if (m) {
    try {
      const parsed = JSON.parse(m[1]);
      actions = Array.isArray(parsed?.actions) ? parsed.actions : [];
    } catch (_) { /* malformed JSON — treat whole thing as reply */ }
    content = content.replace(/```json[\s\S]+?```/, '').trim();
  }

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
