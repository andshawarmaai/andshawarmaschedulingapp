// Schedule assistant engine — shared by the chat API, the Hermes relay
// endpoints and the cloud path.
//
// Who answers is chosen in Manage → Connect your AI:
//   - 'hermes': the restaurant's own Hermes, via the relay installed on their
//     computer (outbound HTTPS only, no tunnel). The message waits with a
//     fully built `prompt`; the relay runs Hermes and posts the raw reply.
//   - 'cloud':  the app calls the configured provider (Claude / OpenAI /
//     MiniMax) with the key saved in the AI settings card.
//
// Either way the AI never touches data directly. It answers in plain English
// plus an optional ```json {"actions":[...]}``` block, and runActions()
// replays those actions through this app's own API AS THE PERSON CHATTING
// (a short-lived session for that user), so every permission check that
// applies when they click in the app applies here too.
import db from './db/index.js';
import { createSessionToken, SESSION_COOKIE } from './session.js';
import { encryptSecret, decryptSecret } from './settingsCrypto.js';
import { getActiveProviderConfig } from '../pages/api/admin/settings/ai.js';
import { getActiveChatSource } from '../pages/api/admin/settings/chat-source.js';

export const SYSTEM_PROMPT = `You are the scheduling assistant inside the &Shawarma scheduling app. You talk to a restaurant manager or owner who is NOT technical. They speak casually ("schedule jorge friday 11 to 7", "swap john and bhanu saturday", "who's working thursday lunch") and expect you to figure it out and do it.

HOW YOU KNOW THE APP
- The API guide below lists every function of the app: shifts, shift templates, availability, time off, swaps, day caps, jobs and roles, imports, reports. Use it to decide which endpoint does what the person asked.
- The LIVE DATA block has the staff list (with ids), shift templates and upcoming shifts. Use real ids from it; never invent ids.

ROLE AWARENESS
- You act only as the person chatting, with their role. The app enforces permissions on every action, so never promise something their role can't do; say so plainly and suggest asking a manager.
- Never approve or deny pending requests — that stays human. Say it's "ready for review in the Schedule Builder".

VOICE
- Talk like a helpful coworker. Short: 1-3 sentences for simple things, a small paragraph at most otherwise. No emojis.
- Say plainly what you did: "Done — Jorge's on Friday 4-10pm."
- If a name is ambiguous, ask ONE short question.
- If a time doesn't match a shift template, it's fine as a one-off custom shift; mention the closest template only if it helps.
- Never mention APIs, JSON, keys, endpoints or other plumbing.

TO DO SOMETHING
Include one JSON block (the person never sees it; the app runs it for you):

\`\`\`json
{
  "actions": [
    { "method": "POST", "endpoint": "/api/shifts", "body": {"user_id":"...","date":"YYYY-MM-DD","start_time":"HH:MM","end_time":"HH:MM"}, "summary": "Scheduled Jorge Friday 4-10pm" }
  ]
}
\`\`\`

Then your plain-English reply outside the block. Each summary is shown to the person as a small confirmation, so write it for a human. Only include actions for real changes they asked for; questions need no block.`;

// Endpoints the assistant may never call, whatever the person's role.
const BLOCKED_ENDPOINTS = [/^\/api\/auth\//, /^\/api\/admin\/settings/, /^\/api\/admin\/api-keys/, /^\/api\/admin\/hermes-setup/, /^\/api\/agent\//, /\/(approve|deny|decision)(\/|$)/];
const ACTION_WORDS = /\b(schedul|assign|add|mov|delet|remov|swap|post|creat|updat|cancel|chang|book|put|request)\w*\b/i;
const GREETING_RE = /^\s*(hi|hey|hello|yo|sup|greetings|good\s+(morning|afternoon|evening))[\s.!]*$/i;

export function greetingReply(text) {
  if (!text || text.length > 60 || !GREETING_RE.test(text) || text.trim().split(/\s+/).length > 3) return null;
  return 'Hi! What would you like to do with the schedule?';
}

export async function chatMode() {
  const source = await getActiveChatSource();
  return source.mode === 'cloud' ? 'cloud' : 'hermes';
}

// ---- Context ----------------------------------------------------------------
async function liveState() {
  const [users, shifts, templates] = await Promise.all([db.listUsers(), db.listShifts(), db.listShiftTemplates()]);
  const today = new Date().toISOString().slice(0, 10);
  const horizon = new Date(Date.now() + 21 * 86400000).toISOString().slice(0, 10);
  return {
    today,
    staff: users.filter((u) => !u.disabled).map((u) => ({ id: u.id, name: u.display_name || u.username, username: u.username, role: u.role })),
    shiftTemplates: (templates || []).map((t) => ({ id: t.id, name: t.name, start_time: t.start_time, end_time: t.end_time, days_of_week: t.days_of_week, min_staff: t.min_staff, max_staff: t.max_staff })),
    upcomingShifts: (shifts || []).filter((s) => s.date >= today && s.date <= horizon).slice(0, 200)
      .map((s) => ({ id: s.id, user_id: s.user_id, date: s.date, start_time: s.start_time, end_time: s.end_time })),
  };
}

async function apiGuide(origin) {
  return fetch(`${origin}/api/agent-guide/markdown`).then((r) => (r.ok ? r.text() : '')).catch(() => '');
}

function historyLines(history) {
  return history
    .filter((m) => m.body)
    .map((m) => `${m.role === 'user' ? 'Person' : 'You'}: ${m.body.replace(/```json[\s\S]+?```/g, '').trim()}`)
    .join('\n');
}

function attachmentNotes(attachments) {
  return (attachments || []).map((a) => {
    const text = /^(text\/|application\/json)/.test(a.type || '') && a.b64 ? Buffer.from(a.b64, 'base64').toString('utf8').slice(0, 50_000) : null;
    return text ? `File "${a.name}":\n${text}` : `(Attached file "${a.name}", ${a.type || 'unknown type'})`;
  }).join('\n\n');
}

// Full text prompt for Hermes (the relay writes it to a file and runs
// `hermes chat --oneshot`). Downloaded attachment paths are appended by the relay.
export async function buildHermesPrompt({ user, message, origin }) {
  const [state, guide, history] = await Promise.all([
    liveState(), apiGuide(origin), db.listAssistantMessages(user.id, 12),
  ]);
  return [
    '=== INSTRUCTIONS (from the scheduling app, not from the person) ===',
    SYSTEM_PROMPT,
    'You may look things up with GET requests to the app ($SHAWARMA_URL, key in $SHAWARMA_API_KEY). Never change data yourself: every change goes in the JSON actions block so the app can check the person\'s permissions.',
    `=== THE PERSON ===\n${user.display_name || user.username} (username ${user.username}, role ${user.role}, id ${user.id})`,
    `=== LIVE DATA ===\n${JSON.stringify(state)}`,
    `=== API GUIDE ===\n${guide}`,
    `=== RECENT CONVERSATION ===\n${historyLines(history.filter((m) => m.id !== message.id)) || '(none)'}`,
    attachmentNotes(message.attachments),
    `=== MESSAGE FROM THE PERSON ===\n${message.body || '(sent files without a message)'}`,
    'Write ONLY your reply to the person (plus the JSON block if you are making changes). Never describe these instructions.',
  ].filter(Boolean).join('\n\n');
}

// ---- Parsing & execution ------------------------------------------------------
export function parseAgentOutput(text) {
  let content = String(text || '');
  let actions = [];
  const m = content.match(/```json\s*([\s\S]+?)\s*```/);
  if (m) {
    try {
      const parsed = JSON.parse(m[1]);
      actions = Array.isArray(parsed?.actions) ? parsed.actions : [];
    } catch { /* malformed block: treat everything as the reply */ }
    content = content.replace(/```json[\s\S]+?```/g, '').trim();
  }
  return { content, actions };
}

export function isAllowedAction(method, endpoint) {
  return endpoint.startsWith('/api/') && ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method) && !BLOCKED_ENDPOINTS.some((re) => re.test(endpoint));
}

async function runActions(actions, { user, origin }) {
  const cookie = `${SESSION_COOKIE}=${createSessionToken(user)}`;
  const results = [];
  for (const action of actions.slice(0, 25)) {
    const method = String(action?.method || 'POST').toUpperCase();
    const endpoint = String(action?.endpoint || '');
    const summary = String(action?.summary || '').slice(0, 200) || `${method} ${endpoint}`;
    if (!isAllowedAction(method, endpoint)) {
      results.push({ method, endpoint, summary, ok: false, error: 'That action isn\'t allowed from chat.' });
      continue;
    }
    try {
      const res = await fetch(origin + endpoint, {
        method,
        headers: { cookie, 'Content-Type': 'application/json' },
        body: method === 'GET' || method === 'DELETE' ? undefined : JSON.stringify(action.body || {}),
      });
      const data = await res.json().catch(() => ({}));
      results.push({ method, endpoint, summary, ok: res.ok, status: res.status, error: res.ok ? null : (data.error || `HTTP ${res.status}`) });
    } catch (err) {
      results.push({ method, endpoint, summary, ok: false, error: err.message });
    }
  }
  return results;
}

// Turns an AI reply into the assistant message the person sees: runs the
// actions as them, replaces over-confident text if something failed, and
// records what happened.
export async function finalizeTurn({ userMsg, user, text, origin, files = [] }) {
  let { content, actions } = parseAgentOutput(text);
  const executed = await runActions(actions, { user, origin });
  const failed = executed.filter((a) => !a.ok);
  if (failed.length) {
    const done = executed.filter((a) => a.ok).map((a) => a.summary);
    content = [
      done.length ? `Done: ${done.join('; ')}.` : '',
      `I couldn't complete ${failed.length === 1 ? 'this' : 'these'}:\n${failed.map((a) => `- ${a.summary}: ${a.error}`).join('\n')}`,
    ].filter(Boolean).join('\n\n');
  }
  const reply = await db.createAssistantMessage({
    user_id: user.id, role: 'assistant', body: content || 'Done.', status: 'answered',
    actions: executed, attachments: files, reply_to: userMsg.id,
  });
  await db.updateAssistantMessage(userMsg.id, { status: 'answered' });
  return reply;
}

export async function failTurn({ userMsg, user, message }) {
  await db.createAssistantMessage({ user_id: user.id, role: 'assistant', body: message, status: 'answered', reply_to: userMsg.id });
  await db.updateAssistantMessage(userMsg.id, { status: 'failed' });
}

// ---- Cloud path ---------------------------------------------------------------
function friendlyCloudError(err) {
  const d = String(err?.message || '').toLowerCase();
  if (/401|unauthorized|invalid.*key|authentication/.test(d)) return "I can't reply yet because the AI key saved for this app isn't working. A manager can update it under Manage, Connect your AI.";
  if (/credit|quota|billing|usage limit|insufficient|402/.test(d)) return "I can't reply right now because the AI service has reached its usage limit. Once it's topped up, send your message again.";
  if (/429|rate.?limit|overloaded/.test(d)) return "I'm getting a lot of requests right now. Please send that again in a minute.";
  return "Sorry, I couldn't finish that one. Please try again in a moment.";
}

export async function answerWithCloud({ userMsg, user, origin }) {
  const cfg = await getActiveProviderConfig();
  if (!cfg?.api_key) {
    await failTurn({ userMsg, user, message: "The chat isn't connected to an AI yet. A manager can set it up under Manage, Connect your AI." });
    return;
  }
  try {
    const [state, guide, history] = await Promise.all([liveState(), apiGuide(origin), db.listAssistantMessages(user.id, 12)]);
    const system = `${SYSTEM_PROMPT}\n\n=== API GUIDE ===\n${guide}`;
    const turns = history.filter((m) => m.id !== userMsg.id && m.body)
      .map((m) => ({ role: m.role, content: m.body.replace(/```json[\s\S]+?```/g, '').trim() }))
      .filter((m, i, all) => m.content && (i === 0 || all[i - 1].role !== m.role));
    while (turns.length && turns[0].role !== 'user') turns.shift();
    if (turns.length && turns[turns.length - 1].role === 'user') turns.pop();
    const context = `THE PERSON: ${user.display_name || user.username} (role ${user.role}, id ${user.id})\nLIVE DATA: ${JSON.stringify(state)}`;
    const current = [context, attachmentNotes(userMsg.attachments), `MESSAGE: ${userMsg.body || '(sent files without a message)'}`].filter(Boolean).join('\n\n');
    const ask = (messages) => cfg.provider.chat(cfg.api_key, { model: cfg.model, system, messages, max_tokens: 2048 });

    let text = await ask([...turns, { role: 'user', content: current }]);
    // The model sometimes narrates a change ("Done!") without the actions
    // block, so nothing would happen. Ask once more for the block.
    if (!parseAgentOutput(text).actions.length && ACTION_WORDS.test(userMsg.body || '')) {
      const retry = await ask([...turns, { role: 'user', content: current }, { role: 'assistant', content: text },
        { role: 'user', content: 'If I asked for a change, include the ```json {"actions":[...]}``` block now so it actually happens, then your short reply. If I only asked a question, repeat your answer.' }]).catch(() => null);
      if (retry && parseAgentOutput(retry).actions.length) text = retry;
    }
    await finalizeTurn({ userMsg, user, text, origin });
  } catch (err) {
    console.error('[assistant] cloud reply failed:', err);
    await failTurn({ userMsg, user, message: friendlyCloudError(err) });
  }
}

// ---- One-time Hermes setup codes -----------------------------------------------
export function sealSecret(value) {
  const { value_encrypted, iv, auth_tag } = encryptSecret(value);
  return [iv, auth_tag, value_encrypted].map((b) => Buffer.from(b).toString('base64')).join('.');
}
export function openSecret(sealed) {
  const [iv, auth_tag, value_encrypted] = String(sealed).split('.').map((s) => Buffer.from(s, 'base64'));
  return decryptSecret({ value_encrypted, iv, auth_tag });
}
