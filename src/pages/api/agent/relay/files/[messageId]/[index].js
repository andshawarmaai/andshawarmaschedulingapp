// GET /api/agent/relay/files/:messageId/:index — the relay downloads a file
// the person attached, so Hermes can read it.
import db from '../../../../../../lib/db/index.js';

export const prerender = false;

export async function GET(context) {
  const me = context.locals.user;
  if (!me?.apiKeyId || !['admin', 'manager'].includes(me.role)) return new Response('Forbidden', { status: 403 });
  const msg = await db.getAssistantMessage(context.params.messageId);
  const file = msg?.role === 'user' ? (msg.attachments || [])[Number(context.params.index)] : null;
  if (!file?.b64) return new Response('Not found.', { status: 404 });
  return new Response(Buffer.from(file.b64, 'base64'), { headers: { 'Content-Type': file.type || 'application/octet-stream' } });
}
