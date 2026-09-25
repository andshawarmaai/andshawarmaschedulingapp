// GET /api/agent/relay/inbox — the restaurant's Hermes relay polls this with
// its API key (created through Manage → Connect your AI → Set up Hermes).
// Returns messages waiting for Hermes, each with a ready-to-run prompt.
import db from '../../../../lib/db/index.js';
import { chatMode } from '../../../../lib/assistant.js';

export const prerender = false;

export async function GET(context) {
  const me = context.locals.user;
  if (!me?.apiKeyId || !['admin', 'manager'].includes(me.role)) return Response.json({ error: 'Use the relay key.' }, { status: 403 });
  const pending = (await chatMode()) === 'hermes' ? await db.listPendingAssistantPrompts(10) : [];
  return Response.json({
    ok: true,
    messages: pending.map((m) => ({
      id: m.id,
      prompt: m.prompt,
      attachments: (m.attachments || []).map((a, i) => ({ name: a.name, type: a.type, url: `/api/agent/relay/files/${m.id}/${i}` })),
      reply_url: `/api/agent/relay/reply/${m.id}`,
    })),
    serverTime: new Date().toISOString(),
  });
}
