// GET/POST /api/admin/settings/assistant — who answers the chat (the
// restaurant's Hermes or the cloud AI key) and whether the relay has checked
// in recently. The cloud provider key itself is managed by the AI card.
import db from '../../../../lib/db/index.js';
import { encryptSecret } from '../../../../lib/settingsCrypto.js';
import { getActiveChatSource } from './chat-source.js';
import { getActiveProviderConfig } from './ai.js';

export const prerender = false;

const canManage = (role) => role === 'admin' || role === 'manager';

export async function GET(context) {
  if (!canManage(context.locals.user.role)) return Response.json({ error: 'Forbidden' }, { status: 403 });
  const [{ mode }, cfg, keys] = await Promise.all([getActiveChatSource(), getActiveProviderConfig(), db.listApiKeys()]);
  const relayLastSeen = keys.filter((k) => !k.revoked && /^Hermes relay/.test(k.label || ''))
    .map((k) => k.last_used_at).filter(Boolean).map((d) => new Date(d).toISOString()).sort().pop() || null;
  return Response.json({ ok: true, mode, cloudReady: !!cfg?.api_key, relayLastSeen });
}

export async function POST(context) {
  const me = context.locals.user;
  if (!canManage(me.role)) return Response.json({ error: 'Forbidden' }, { status: 403 });
  const { mode } = await context.request.json().catch(() => ({}));
  if (!['hermes', 'cloud'].includes(mode)) return Response.json({ error: 'Pick Hermes or Cloud AI.' }, { status: 400 });
  await db.setSetting('chat_source', encryptSecret(JSON.stringify({ mode })), me.id);
  return Response.json({ ok: true, mode });
}
