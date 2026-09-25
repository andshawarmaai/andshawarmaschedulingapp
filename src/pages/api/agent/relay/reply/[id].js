// POST /api/agent/relay/reply/:id — the relay posts Hermes's answer:
// { reply, status?: 'answered'|'failed', files?: [{ name, content_type, content_b64 }] }.
// The app runs any actions in the reply AS THE PERSON who sent the message
// (their role's permissions), never as the relay key's owner.
import db from '../../../../../lib/db/index.js';
import { finalizeTurn, failTurn } from '../../../../../lib/assistant.js';
import { publicOrigin } from '../../../../../lib/publicOrigin.js';

export const prerender = false;

const MAX_FILE_BYTES = 3 * 1024 * 1024;

export async function POST(context) {
  const me = context.locals.user;
  if (!me?.apiKeyId || !['admin', 'manager'].includes(me.role)) return Response.json({ error: 'Use the relay key.' }, { status: 403 });
  const userMsg = await db.getAssistantMessage(context.params.id);
  if (!userMsg || userMsg.role !== 'user') return Response.json({ error: 'Message not found.' }, { status: 404 });
  if (userMsg.status !== 'pending') return Response.json({ ok: true, duplicate: true });

  const body = await context.request.json().catch(() => ({}));
  const user = await db.getUserById(userMsg.user_id);
  if (!user || user.disabled) return Response.json({ error: 'That person no longer has access.' }, { status: 410 });

  const reply = String(body.reply || '').trim().slice(0, 12_000);
  if (body.status === 'failed' || !reply) {
    await failTurn({ userMsg, user, message: reply || "Sorry, I couldn't finish that one. Please try again in a moment." });
    return Response.json({ ok: true });
  }
  const files = (Array.isArray(body.files) ? body.files : []).slice(0, 5)
    .map((f) => ({ name: String(f.name || 'file').replace(/[^\w.\- ]+/g, '_').slice(-120), type: String(f.content_type || 'application/octet-stream').slice(0, 100), b64: String(f.content_b64 || ''), output: true }))
    .map((f) => ({ ...f, size: Math.floor(f.b64.length * 0.75) }))
    .filter((f) => f.b64 && f.size <= MAX_FILE_BYTES);
  const answer = await finalizeTurn({ userMsg, user, text: reply, origin: publicOrigin(context), files });
  return Response.json({ ok: true, id: answer.id });
}
