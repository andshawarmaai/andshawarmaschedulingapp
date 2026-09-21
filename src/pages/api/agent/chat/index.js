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
import { getActiveChatSource } from '../../admin/settings/chat-source.js';
import { readFile } from 'node:fs/promises';
import { waitUntil } from '@vercel/functions';

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

const SYSTEM_PROMPT = `You are the scheduling assistant inside the &Shawarma scheduling app. You talk to a restaurant manager, owner, or staff member who is NOT technical. They will speak casually ("schedule jorge friday 11 to 7", "swap john and bhanu saturday", "who's working thursday lunch") and expect you to just figure it out and do it.

ROLE AWARENESS — CRITICAL:
- The current user is calling the chat from a specific role (admin/manager/staff). This is sent to you as the user's role. Act only on behalf of that user.
- STAFF members can submit their OWN availability, request their OWN time off, post their OWN shifts for swap, and volunteer for swaps. They cannot add/move/delete OTHER people's shifts, edit templates, or change day caps. If a staff member asks for something they can't do, say so plainly and tell them to ask their manager.
- ADMIN/MANAGER can do everything staff can, plus add/move/delete anyone's shifts, edit shift templates, set day caps, and bulk-import. They still cannot approve/deny pending requests — those are human-only by design.
- NEVER do an action for one user that's attributed to another. Always work AS the current user.

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

async function executeAction(action, callerCookie, origin) {
  const method = action.method || 'POST';
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

// ─── Fast-path: pure greetings skip the LLM entirely ───
//
// "hi" / "hello" / "hey" should reply in ~50-200ms, not 5-15s. The full
// orchestrator path (history fetch + state fetch + guide fetch + bridge
// spawn + MCP spawn + LLM turn) for a one-word greeting is a waste of
// tokens and a real UX problem on a cold start (CHAT_BOT_HANDOFF_V6.md
// follow-up). This helper detects a pure greeting and returns a canned
// reply matching the bot's voice (per CHAT_BOT_PROMPT in
// scripts/hermes-bridge.mjs): short, never self-references as AI,
// scheduling-scoped. Only fires on a clearly-greeting-only message —
// if there's ANY scheduling intent (a name, a day, a time, a verb like
// "schedule"/"swap"/"cancel"), the message goes to the real agent.
const GREETING_RE = /^\s*(hi|hey|hello|yo|sup|greetings|good\s+(morning|afternoon|evening))[\s.!]*$/i;

function pureGreeting(text) {
  if (!text) return null;
  if (text.length > 60) return null; // anything longer is probably a real question
  if (!GREETING_RE.test(text)) return null;
  // Single-token matches only ("hi", "hey", "hello"); multi-word phrases like
  // "hi can you help me" must NOT short-circuit.
  if (text.trim().split(/\s+/).length > 3) return null;
  return 'Hey, what shift do you need to set up?';
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
  // Accept either JSON { content, attachment_ids? } OR multipart/form-data
  // for clients that want to send everything in one shot. The upload.js
  // endpoint is the dedicated file endpoint — this handler just stitches
  // already-uploaded attachments onto the message they belong to.
  const contentType = context.request.headers.get('content-type') || '';
  let body = null;
  let attachmentIds = [];
  if (contentType.includes('application/json')) {
    body = await context.request.json().catch(() => null);
  } else if (contentType.includes('multipart/form-data')) {
    const form = await context.request.formData();
    body = { content: form.get('content') || '' };
    const idsField = form.getAll('attachment_ids').flatMap((v) => String(v).split(','));
    attachmentIds = idsField.filter(Boolean);
  }
  if (!body || (!String(body.content || '').trim() && attachmentIds.length === 0)) {
    return json({ error: 'Message content or at least one attachment is required.' }, 400);
  }
  // All signed-in users can chat. The AI decides what's actually
  // possible per role; the per-endpoint role gates still enforce server-side.
  if (!me) {
    return json({ error: 'Unauthorized' }, 401);
  }

  // 1. Persist the user message
  const userMsg = await chat.createChatMessage({
    user_id: me.id,
    role: 'user',
    content: String(body.content || '').trim(),
    parent_id: body.parent_id || null,
  });

  // 2. Link any attachments the client uploaded first (via /upload with
  //    message_id null, which created a placeholder row) onto THIS message.
  //    Verified ownership: the caller must own each attachment.
  if (attachmentIds.length) {
    for (const aid of attachmentIds) {
      const att = await chat.getChatAttachment(aid);
      if (!att) continue;
      if (att.user_id !== me.id) continue;
      // Move the attachment from its placeholder message to this one
      // by re-inserting into agent_chat_attachments with the new
      // message_id and deleting the placeholder row.
      await chat.createChatAttachment({
        id: aid,
        message_id: userMsg.id,
        user_id: att.user_id,
        filename: att.filename,
        mime_type: att.mime_type,
        byte_size: att.byte_size,
        storage_path: att.storage_path,
      });
      await chat.deleteChatAttachment(aid);
      // The old placeholder user-message row (if any) is now empty +
      // orphaned. Leave it — getChatHistory filters by user_id but the
      // SSE/UI will hide empty user messages naturally. Cleanest fix
      // would be DELETE FROM agent_chat_messages WHERE content='' AND
      // id NOT IN (SELECT message_id FROM agent_chat_attachments), but
      // that's a janitor job, not in the request path.
    }
  }

  // 2. Decide where to route the message based on the configured chat
  //    source: hermes (tunnel), cloud (provider API key), hybrid
  //    (hermes first, cloud fallback), or stub (no AI — plain echo).
  const source = await getActiveChatSource();
  const cloudCfg = await getActiveProviderConfig();
  const useCloud = source.mode === 'cloud' || (source.mode === 'hybrid' && !source.tunnelUrl);
  const useHermes = (source.mode === 'hermes' || source.mode === 'hybrid') && source.tunnelUrl;

  // Stub when nothing's configured — echo + helpful guidance, no AI spend.
  if (!useCloud && !useHermes) {
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
  // waitUntil keeps the serverless function alive for this promise after
  // the response below is sent. Without it, Vercel is free to reclaim the
  // function the moment the HTTP response completes — a plain
  // fire-and-forget `.catch()` here would race the platform: a fast
  // Hermes/cloud reply (e.g. "hello") finishes before reclamation and
  // works, but a slower one (an actual schedule change, which involves a
  // tunnel round-trip + local CLI spawn) gets killed mid-flight with the
  // user message stuck in 'pending' forever and no assistant row ever
  // written. Matches the exact symptom reported in
  // CHAT_BOT_HANDOFF_V2.md ("Problem B").
  waitUntil(
    orchestrateReply({
      userMsg,
      userId: me.id,
      username: me.username,
      displayName: me.display_name,
      callerCookie,
      origin: context.url.origin,
      source,
      cloudCfg,
    }).catch((err) => console.error('orchestration failed:', err))
  );

  return json({ ok: true, message: userMsg }, 201);
}

// ─── Async orchestration: build context, call agent, execute actions, write reply ───
//
// Three modes (set in Manage → Chat Bot):
//   - 'hermes':  POST to local tunnel. If tunnel is unreachable, error
//                out so the manager knows their Mac isn't available.
//   - 'cloud':   Direct API call to the cloud provider (Claude / OpenAI
//                / MiniMax) using the key in the AI settings card.
//   - 'hybrid':  Try tunnel first; if it doesn't respond within 3s,
//                fall back to cloud automatically.
async function orchestrateReply({ userMsg, userId, username, displayName, callerCookie, origin, source, cloudCfg }) {
  // Fast-path: a pure greeting ("hi" / "hey" / "good morning") needs no
  // history, no state, no guide, no LLM call, no bridge/MCP spawn. Reply
  // in ~50-200ms and exit. Anything with scheduling intent still goes
  // through the full pipeline below.
  const canned = pureGreeting(userMsg.content);
  if (canned) {
    try {
      const assistant = await chat.createChatMessage({
        user_id: userId,
        role: 'assistant',
        content: canned,
        parent_id: userMsg.id,
      });
      await chat.updateChatMessageStatus(assistant.id, 'complete');
    } catch (err) {
      console.error('greeting fast-path failed:', err);
    }
    return;
  }

  // Build shared context (state, history, guide) — used by both paths.
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
      // File paths (one per attachment) the agent should read before
      // answering. For images this is essential — the AI can't act on
      // "look at this photo of the schedule" without an actual path it
      // can stat(). For PDFs / audio the agent may either transcribe or
      // ask the user to describe. Server reads the file, passes a base64
      // blob alongside for cloud providers that can't reach the server's
      // disk; the local Hermes tunnel gets the raw path and reads it
      // itself.
      attachments: await Promise.all(
        (await chat.getChatAttachmentsForMessage(userMsg.id)).map(async (a) => {
          let base64 = null;
          // Inline the bytes — agents on cloud providers can't read our
          // server's tmpfs, so they need the actual content in the payload.
          // For files >2MB we skip the inline base64 and just send the
          // metadata + URL, so the cloud agent can tell the user the file
          // is too large to inline-attach.
          if (a.byte_size <= 2 * 1024 * 1024) {
            try {
              base64 = (await readFile(a.storage_path)).toString('base64');
            } catch (_) { base64 = null; }
          }
          return {
            id: a.id,
            filename: a.filename,
            mime_type: a.mime_type,
            byte_size: a.byte_size,
            storage_path: a.storage_path,
            base64,
          };
        })
      ),
    },
    history,
    state: {
      users: (state.users || []).map((u) => ({ username: u.username, display_name: u.display_name, role: u.role })),
      shiftTemplates: state.shiftTemplates,
      upcomingShifts: (state.shifts || []).filter((s) => s.date >= new Date().toISOString().slice(0, 10)).slice(0, 30),
    },
    guide,
  };

  // Try Hermes (tunnel) — used by mode='hermes' and the first attempt of 'hybrid'.
  let assistantText = null;
  let triedHermes = false;
  let hermesError = null;
  if ((source.mode === 'hermes' || source.mode === 'hybrid') && source.tunnelUrl) {
    triedHermes = true;
    assistantText = await callHermes(source.tunnelUrl, payload).catch((err) => {
      hermesError = err.message;
      return null;
    });
  }

  // If we're in hermes-only and it failed, surface the error.
  if (source.mode === 'hermes' && !assistantText) {
    const assistant = await chat.createChatMessage({
      user_id: userId,
      role: 'assistant',
      content: `Hermes wasn't reachable at ${source.tunnelUrl}. Make sure your Mac is on and the bridge is running.\n\nError: ${hermesError || 'no response'}`,
      parent_id: userMsg.id,
    });
    await chat.updateChatMessageStatus(assistant.id, 'error');
    return;
  }

  // If we got a reply from Hermes, we're done — skip cloud.
  if (!assistantText && (source.mode === 'cloud' || source.mode === 'hybrid') && cloudCfg) {
    try {
      const messages = [...history, { role: 'user', content: userMsg.content }];
      assistantText = await cloudCfg.provider.chat(cloudCfg.api_key, {
        model: cloudCfg.model,
        system: SYSTEM_PROMPT + '\n\n' + guide,
        messages,
        max_tokens: 2048,
      });
    } catch (err) {
      const fallback = triedHermes
        ? `I tried Hermes (got: ${hermesError}) and the cloud provider (got: ${err.message}). Set up one of them in Manage → Chat Bot.`
        : `The ${cloudCfg.provider.label || cloudCfg.provider} agent failed: ${err.message}`;
      const assistant = await chat.createChatMessage({
        user_id: userId,
        role: 'assistant',
        content: fallback,
        parent_id: userMsg.id,
      });
      await chat.updateChatMessageStatus(assistant.id, 'error');
      return;
    }
  }

  if (!assistantText) {
    // Shouldn't happen — POST handler already short-circuits when nothing's configured.
    const assistant = await chat.createChatMessage({
      user_id: userId,
      role: 'assistant',
      content: 'No chat source is configured. Open Manage → Chat Bot to pick Hermes, Cloud, or Hybrid.',
      parent_id: userMsg.id,
    });
    await chat.updateChatMessageStatus(assistant.id, 'error');
    return;
  }

  // Extract any JSON action block from the assistant's reply. The
  // tunnel contract returns { content, actions: [...] } directly; the
  // cloud path returns plain text that follows the system prompt's
  // instructions: a ```json``` block with the actions, then the reply.
  let content = '';
  let actions = [];
  // Set by hermes-bridge.mjs only when its scheduling MCP toolset was
  // enabled for this call — meaning Hermes already executed any real
  // actions itself, directly against this app's API (see
  // scripts/mcp-server.mjs). An empty `actions` array in that case is
  // correct and expected, not a sign anything was skipped: there is
  // nothing left for this orchestrator to execute, and no missing-block
  // retry to attempt (that heuristic exists for the OLD text-plus-JSON
  // approach this replaces — firing it here would just waste a second
  // Hermes call on every single successful MCP turn).
  const mcpExecuted = typeof assistantText === 'object' && assistantText !== null && !!assistantText.mcp_executed;
  if (typeof assistantText === 'object' && assistantText !== null) {
    content = assistantText.content || '';
    actions = Array.isArray(assistantText.actions) ? assistantText.actions : [];
  } else {
    content = String(assistantText);
    const m = content.match(/```json\s*([\s\S]+?)\s*```/);
    if (m) {
      try {
        const parsed = JSON.parse(m[1]);
        actions = Array.isArray(parsed?.actions) ? parsed.actions : [];
      } catch (_) { /* malformed JSON — treat whole thing as reply */ }
      content = content.replace(/```json[\s\S]+?```/, '').trim();
    }
  }

  // The model sometimes narrates a schedule change ("Done — Jorge's on
  // Friday 4-10pm") without emitting the ```json {"actions":[...]}```
  // block the orchestrator actually parses and executes — so nothing
  // happens even though the reply sounds confident. This is a separate
  // failure mode from the one handled below (an action that WAS emitted
  // but failed to execute): here, no action was emitted at all. The block
  // is never shown to the user, so there's no cost to asking the model to
  // try again. Retry once, only when the user's own message plausibly
  // asked for a real change (not e.g. "hello" or "who's working Thursday").
  const impliesAction = !mcpExecuted && actions.length === 0 && /\b(schedul|assign|add|mov|delet|remov|swap|post|creat|updat|cancel|chang|book|put)\w*\b/i.test(userMsg.content);
  if (impliesAction) {
    const reminder = '\n\n[SYSTEM REMINDER] Your previous reply did not include the required ```json {"actions":[...]}``` block, so nothing was actually done — a plain-English confirmation alone never performs the action. That block is never shown to the user, only your one-sentence reply is, so there is no downside to including it. If the user asked for a real schedule change, emit the block now in the exact format instructed, followed by your plain-English reply.';
    let retryText = null;
    if (triedHermes && source.tunnelUrl) {
      retryText = await callHermes(source.tunnelUrl, {
        ...payload,
        message: { ...payload.message, content: payload.message.content + reminder },
      }).catch(() => null);
    } else if (cloudCfg) {
      try {
        const retryMessages = [...history, { role: 'user', content: userMsg.content }, { role: 'assistant', content }, { role: 'user', content: reminder }];
        retryText = await cloudCfg.provider.chat(cloudCfg.api_key, {
          model: cloudCfg.model,
          system: SYSTEM_PROMPT + '\n\n' + guide,
          messages: retryMessages,
          max_tokens: 2048,
        });
      } catch (_) { retryText = null; }
    }
    if (retryText) {
      let retryContent = '';
      let retryActions = [];
      if (typeof retryText === 'object' && retryText !== null) {
        retryContent = retryText.content || '';
        retryActions = Array.isArray(retryText.actions) ? retryText.actions : [];
      } else {
        retryContent = String(retryText);
        const rm = retryContent.match(/```json\s*([\s\S]+?)\s*```/);
        if (rm) {
          try {
            const parsed = JSON.parse(rm[1]);
            retryActions = Array.isArray(parsed?.actions) ? parsed.actions : [];
          } catch (_) { /* malformed JSON — keep whatever we already had */ }
          retryContent = retryContent.replace(/```json[\s\S]+?```/, '').trim();
        }
      }
      // Only adopt the retry if it actually produced an action — otherwise
      // keep the original (still-valid) reply rather than replacing a good
      // plain-text answer with a worse one.
      if (retryActions.length > 0) {
        actions = retryActions;
        content = retryContent || content;
      }
    }
  }

  // Execute each action via this app's own /api/* routes (using the
  // caller's session cookie so audit attribution is correct).
  const executed = [];
  for (const action of actions) {
    if (!action || !action.endpoint) continue;
    const result = await executeAction(action, callerCookie, origin);
    executed.push(result);
  }

  // The model wrote `content` (e.g. "Done — Jorge's on Friday 4-10pm")
  // BEFORE any action actually ran — it's a prediction, not a report.
  // If any action actually failed, don't let that confident narration
  // stand uncorrected: a manager reading "Done" has no reason to check
  // the small pass/fail pill under the bubble. Replace the bubble text
  // with what actually happened for the failed ones.
  const failed = executed.filter((a) => !(a.response_status >= 200 && a.response_status < 300));
  if (failed.length) {
    const reasons = failed.map((a) => {
      const errMsg = (a.response_body && typeof a.response_body === 'object' && a.response_body.error)
        || (typeof a.response_body === 'string' && a.response_body)
        || `HTTP ${a.response_status}`;
      return `- ${a.summary || a.endpoint}: ${errMsg}`;
    });
    const okSummaries = executed.filter((a) => a.response_status >= 200 && a.response_status < 300).map((a) => a.summary).filter(Boolean);
    const parts = [];
    if (okSummaries.length) parts.push(`Done: ${okSummaries.join('; ')}.`);
    parts.push(`I couldn't actually complete ${failed.length === 1 ? 'this' : 'these'}:\n${reasons.join('\n')}`);
    content = parts.join('\n\n');
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

// POST {tunnel_url} → context: payload { message, history, state, guide }
// Returns { content, actions[] } or throws.
async function callHermes(tunnelUrl, payload) {
  const controller = new AbortController();
  // Was 30000 — shorter than the bridge's own REQUEST_TIMEOUT_MS (55000
  // in scripts/hermes-bridge.mjs), so this would abort a healthy-but-slow
  // MCP-enabled call before the bridge itself ever gave up. A cold MCP
  // server spawn + tool discovery + an actual tool call (which itself
  // round-trips to this app's live API) easily exceeds 30s, especially
  // on the first call of a session. Raised to 56000 — just under the
  // bridge's 55s budget plus a hair of margin, and under Vercel's
  // maxDuration: 60 (astro.config.mjs) so the platform doesn't kill the
  // function before this fetch would time out on its own.
  const timer = setTimeout(() => controller.abort(), 56000);
  try {
    const r = await fetch(`${tunnelUrl.replace(/\/$/, '')}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      throw new Error(`HTTP ${r.status}: ${t.slice(0, 200)}`);
    }
    return await r.json();
  } finally {
    clearTimeout(timer);
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
  // Include attachments for every message — chat UI renders thumbnails
  // (images) and download chips (PDFs, audio) inline. One batch fetch
  // rather than per-message so the history load is one round-trip.
  const messageIds = history.map((m) => m.id);
  const attRows = await chat.getChatAttachmentsForMessages(messageIds);
  const attachments = {};
  for (const a of attRows) {
    (attachments[a.message_id] ||= []).push({
      id: a.id,
      filename: a.filename,
      mime_type: a.mime_type,
      byte_size: a.byte_size,
      url: `/api/agent/chat/attachments/${a.id}`,
    });
  }
  // Include the resolved user for each message so the panel can render
  // "You: ..." vs "Hermes: ..." correctly even when seeded via the API
  // key (which acts as the manager, so role='assistant' but the message
  // is from a real person).
  return json({ ok: true, history, actions, attachments, me: { id: me.id, display_name: me.display_name } });
}
