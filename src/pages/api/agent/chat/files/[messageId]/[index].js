// GET /api/agent/chat/files/:messageId/:index — download a file from your own
// chat (one you attached, or one the assistant made for you).
import db from '../../../../../../lib/db/index.js';

export const prerender = false;

export async function GET(context) {
  const me = context.locals.user;
  const msg = await db.getAssistantMessage(context.params.messageId);
  const file = msg && msg.user_id === me.id ? (msg.attachments || [])[Number(context.params.index)] : null;
  if (!file?.b64) return new Response('Not found.', { status: 404 });
  return new Response(Buffer.from(file.b64, 'base64'), {
    headers: {
      'Content-Type': file.type || 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${String(file.name).replace(/"/g, '')}"`,
      'Cache-Control': 'private, no-store',
    },
  });
}
