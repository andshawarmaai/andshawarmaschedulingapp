// Chat bot identity — display name + avatar shown in the chat panel.
// Admin-only (the Manage page hides this whole card for non-admins).
//
// One row in app_settings: key='chat_identity', value JSON:
//   { name?: string, avatar?: string (data: URI) }
//
// The avatar is stored as a data URI directly in the setting value rather
// than as a file — the UI caps uploads at 30KB specifically so this stays
// small enough to live inline without needing object storage.

import dbCore from '../../../../lib/db/index.js';
import { encryptSecret, decryptSecret } from '../../../../lib/settingsCrypto.js';

export const prerender = false;

const SETTINGS_KEY = 'chat_identity';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

async function readIdentity() {
  const raw = await dbCore.getSetting(SETTINGS_KEY);
  if (!raw) return {};
  try {
    return JSON.parse(decryptSecret(raw));
  } catch (_) {
    return {};
  }
}

export async function GET(context) {
  const me = context.locals.user;
  if (me.role !== 'admin') return json({ error: 'Forbidden' }, 403);
  const identity = await readIdentity();
  return json({ ok: true, name: identity.name || null, avatar: identity.avatar || null });
}

export async function POST(context) {
  const me = context.locals.user;
  if (me.role !== 'admin') return json({ error: 'Forbidden' }, 403);
  const body = await context.request.json().catch(() => null);
  if (!body || (body.name === undefined && body.avatar === undefined)) {
    return json({ error: 'Provide name and/or avatar.' }, 400);
  }
  if (body.avatar !== undefined && body.avatar !== null) {
    if (typeof body.avatar !== 'string' || !body.avatar.startsWith('data:image/')) {
      return json({ error: 'avatar must be a data:image/... URI, or null to remove it.' }, 400);
    }
    // Roughly matches the client's 30KB cap on the decoded file, allowing
    // for base64 overhead (~4/3 the raw size) plus the data: URI header.
    if (body.avatar.length > 42 * 1024) {
      return json({ error: 'Image is too large — 30KB or smaller.' }, 400);
    }
  }
  const current = await readIdentity();
  const next = { ...current };
  if (body.name !== undefined) next.name = String(body.name).trim().slice(0, 60) || undefined;
  if (body.avatar !== undefined) next.avatar = body.avatar || undefined;
  const encrypted = encryptSecret(JSON.stringify(next));
  await dbCore.setSetting(SETTINGS_KEY, encrypted, me.id);
  return json({ ok: true, name: next.name || null, avatar: next.avatar || null });
}

// Used by the chat UI/orchestrator to show the configured name/avatar
// instead of a generic default.
export async function getChatIdentity() {
  const identity = await readIdentity();
  return { name: identity.name || null, avatar: identity.avatar || null };
}
