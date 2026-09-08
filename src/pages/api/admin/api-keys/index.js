// Gated to admin/manager by middleware.js (ADMIN_ONLY_PREFIXES covers /api/admin).
// Creating a key returns the full plaintext value exactly once — after
// this response, only its hash is stored, same as a password.
import db from '../../../../lib/db/index.js';
import { generateApiKey, keyPrefix, hashApiKey } from '../../../../lib/apiKey.js';

export const prerender = false;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

export async function POST(context) {
  const me = context.locals.user;
  const body = await context.request.json().catch(() => null);
  const label = (body && body.label ? String(body.label) : '').trim();
  if (!label) return json({ error: 'A label is required (e.g. "Hermes").' }, 400);

  const rawKey = generateApiKey();
  const key = await db.createApiKeyRecord({
    label,
    key_prefix: keyPrefix(rawKey),
    key_hash: hashApiKey(rawKey),
    created_by: me.id,
  });

  return json({
    ok: true,
    key: rawKey,
    record: { id: key.id, label: key.label, key_prefix: key.key_prefix, created_at: key.created_at },
  }, 201);
}
