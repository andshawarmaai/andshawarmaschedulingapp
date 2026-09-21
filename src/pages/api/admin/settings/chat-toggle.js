// Master on/off switch for the chat bubble/panel, shown on every page via
// Layout.astro. Independent of chat SOURCE (chat-source.js) — this only
// controls whether the bubble renders at all; the source picker decides
// where a message goes once someone opens it.
//
// One row in app_settings: key='chat_enabled', value JSON: { enabled: bool }
// Defaults to enabled (true) when no row exists yet, so the chat bubble
// shows out of the box without requiring an admin to opt in first.

import dbCore from '../../../../lib/db/index.js';
import { encryptSecret, decryptSecret } from '../../../../lib/settingsCrypto.js';

export const prerender = false;

const SETTINGS_KEY = 'chat_enabled';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function isStaffOrAbove(role) {
  return role === 'admin' || role === 'manager';
}

export async function GET(context) {
  const me = context.locals.user;
  if (!isStaffOrAbove(me.role)) return json({ error: 'Forbidden' }, 403);
  const enabled = await getChatEnabled();
  return json({ ok: true, enabled });
}

export async function POST(context) {
  const me = context.locals.user;
  if (!isStaffOrAbove(me.role)) return json({ error: 'Forbidden' }, 403);
  const body = await context.request.json().catch(() => null);
  if (typeof body?.enabled !== 'boolean') {
    return json({ error: 'enabled must be a boolean.' }, 400);
  }
  const encrypted = encryptSecret(JSON.stringify({ enabled: body.enabled }));
  await dbCore.setSetting(SETTINGS_KEY, encrypted, me.id);
  return json({ ok: true, enabled: body.enabled });
}

// Used by Layout.astro on every page render to decide whether to include
// the chat bubble at all.
export async function getChatEnabled() {
  const raw = await dbCore.getSetting(SETTINGS_KEY);
  if (!raw) return true;
  try {
    const v = JSON.parse(decryptSecret(raw));
    return v.enabled !== false;
  } catch (_) {
    return true;
  }
}
