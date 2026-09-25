// POST /api/admin/hermes-setup — a manager/admin starts connecting their
// computer's Hermes. Creates the relay API key server-side and returns only a
// one-time setup code (15 minutes) inside the install command; the installer
// trades the code for the key, so the key itself is never shown or copied.
import crypto from 'node:crypto';
import db from '../../../lib/db/index.js';
import { generateApiKey, keyPrefix, hashApiKey } from '../../../lib/apiKey.js';
import { sealSecret } from '../../../lib/assistant.js';
import { publicOrigin } from '../../../lib/publicOrigin.js';

export const prerender = false;

export async function POST(context) {
  const me = context.locals.user;
  if (!['admin', 'manager'].includes(me.role)) return Response.json({ error: 'Managers and admins only.' }, { status: 403 });
  const key = generateApiKey();
  await db.createApiKeyRecord({
    label: `Hermes relay (${new Date().toISOString().slice(0, 10)})`,
    key_prefix: keyPrefix(key), key_hash: hashApiKey(key), created_by: me.id,
  });
  const code = 'setup_' + crypto.randomBytes(18).toString('base64url');
  const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
  await db.createSetupCode({
    code_hash: crypto.createHash('sha256').update(code).digest('hex'),
    sealed_key: sealSecret(key), created_by: me.id, expires_at: expiresAt,
  });
  const origin = publicOrigin(context);
  return Response.json({ ok: true, command: `curl -fsSL ${origin}/install-relay.sh | SHAWARMA_URL=${origin} bash -s -- ${code}`, expiresAt });
}
