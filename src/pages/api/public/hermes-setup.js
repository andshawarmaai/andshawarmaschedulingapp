// POST /api/public/hermes-setup { code } — called by install-relay.sh on the
// restaurant's computer: trades a one-time setup code for the relay key.
// Unauthenticated by design (the code is the credential); single use and
// expires after 15 minutes.
import crypto from 'node:crypto';
import db from '../../../lib/db/index.js';
import { openSecret } from '../../../lib/assistant.js';

export const prerender = false;

export async function POST(context) {
  const { code } = await context.request.json().catch(() => ({}));
  if (!String(code || '').startsWith('setup_')) return Response.json({ error: 'Invalid setup code.' }, { status: 400 });
  const claimed = await db.claimSetupCode(crypto.createHash('sha256').update(String(code)).digest('hex'));
  if (!claimed) {
    return Response.json({ error: 'This setup code has expired or was already used. Click "Set up Hermes" in the app for a new one.' }, { status: 410 });
  }
  return Response.json({ ok: true, key: openSecret(claimed.sealed_key) });
}
