// GET    /api/agent/chat — this person's chat thread + which AI answers.
// POST   /api/agent/chat — { message, files?: [{ name, type, b64 }] }.
//        Cloud mode answers in the background (waitUntil); Hermes mode stores
//        a ready-to-run prompt that the restaurant's relay picks up.
// DELETE /api/agent/chat — clear this person's thread.
// Managers and admins only (see isStaffOrAbove); engine in src/lib/assistant.js.
import { waitUntil } from '@vercel/functions';
import db from '../../../../lib/db/index.js';
import { chatMode, greetingReply, buildHermesPrompt, answerWithCloud } from '../../../../lib/assistant.js';
import { getActiveProviderConfig } from '../../admin/settings/ai.js';

export const prerender = false;

const MAX_UPLOAD_BYTES = 3 * 1024 * 1024; // whole request must stay under Vercel's 4.5 MB limit

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}
const canChat = (role) => role === 'admin' || role === 'manager';

// Never send file bytes back in the thread; only what the chat shows.
function publicMessage(m) {
  return {
    id: m.id, role: m.role, body: m.body, status: m.status, created_at: m.created_at,
    actions: (m.actions || []).map((a) => ({ summary: a.summary, ok: a.ok, error: a.error })),
    attachments: (m.attachments || []).map((a) => ({ name: a.name, size: a.size, type: a.type, output: !!a.output })),
  };
}

export async function GET(context) {
  const me = context.locals.user;
  if (!canChat(me.role)) return json({ error: 'Forbidden' }, 403);
  const messages = await db.listAssistantMessages(me.id);
  const mode = await chatMode();
  // Online = can answer right now: a cloud key is saved, or the restaurant's
  // Hermes relay checked in within the last 2 minutes. The model/provider is
  // never exposed to the chat.
  let online;
  if (mode === 'cloud') online = !!(await getActiveProviderConfig())?.api_key;
  else {
    const keys = await db.listApiKeys();
    const seen = keys.filter((k) => !k.revoked && /^Hermes relay/.test(k.label || '') && k.last_used_at).map((k) => new Date(k.last_used_at).getTime());
    online = seen.length > 0 && Date.now() - Math.max(...seen) < 2 * 60 * 1000;
  }
  return json({ ok: true, mode, online, messages: messages.map(publicMessage) });
}

export async function POST(context) {
  const me = context.locals.user;
  if (!canChat(me.role)) return json({ error: 'Forbidden' }, 403);
  const payload = await context.request.json().catch(() => null);
  const body = String(payload?.message || '').trim().slice(0, 4000);
  const files = (Array.isArray(payload?.files) ? payload.files : []).slice(0, 5).map((f) => {
    const b64 = String(f?.b64 || '');
    return { name: String(f?.name || 'file').replace(/[^\w.\- ]+/g, '_').slice(-120), type: String(f?.type || 'application/octet-stream').slice(0, 100), size: Math.floor(b64.length * 0.75), b64 };
  }).filter((f) => f.b64);
  if (!body && !files.length) return json({ error: 'Type a message or attach a file.' }, 400);
  if (files.reduce((n, f) => n + f.size, 0) > MAX_UPLOAD_BYTES) return json({ error: 'Attachments are limited to 3 MB per message.' }, 413);

  const user = await db.getUserById(me.id);
  const userMsg = await db.createAssistantMessage({ user_id: me.id, role: 'user', body, attachments: files });

  const greeting = !files.length && greetingReply(body);
  if (greeting) {
    await db.createAssistantMessage({ user_id: me.id, role: 'assistant', body: greeting, status: 'answered', reply_to: userMsg.id });
    await db.updateAssistantMessage(userMsg.id, { status: 'answered' });
    return json({ ok: true }, 201);
  }

  const origin = context.url.origin;
  if ((await chatMode()) === 'cloud') {
    waitUntil(answerWithCloud({ userMsg, user, origin }));
  } else {
    await db.updateAssistantMessage(userMsg.id, { prompt: await buildHermesPrompt({ user, message: userMsg, origin }) });
  }
  return json({ ok: true }, 201);
}

export async function DELETE(context) {
  const me = context.locals.user;
  if (!canChat(me.role)) return json({ error: 'Forbidden' }, 403);
  await db.clearAssistantMessages(me.id);
  return json({ ok: true });
}
