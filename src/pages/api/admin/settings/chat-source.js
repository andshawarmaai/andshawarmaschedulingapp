// Chat source configuration — who answers the chat. Picked in Manage →
// Chat Bot (no env vars or redeploys needed).
//
// Modes:
//   - 'hermes' — the restaurant's own Hermes, via the relay installed on
//                their computer (outbound HTTPS only, no tunnel). See
//                src/lib/assistant.js and public/install-relay.sh.
//   - 'cloud'  — the provider key in the AI card (Claude / OpenAI / MiniMax).
//
// Stored value: { mode: 'hermes'|'cloud' }. Older saved values ('hybrid',
// 'stub') are read as 'hermes'.

import dbCore from '../../../../lib/db/index.js';
import { encryptSecret, decryptSecret } from '../../../../lib/settingsCrypto.js';

export const prerender = false;

const SETTINGS_KEY = 'chat_source';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function isStaffOrAbove(role) {
  return role === 'admin' || role === 'manager';
}

// Probe the tunnel URL with a short timeout. Used by GET to surface
// "reachable"/"unreachable" so the admin sees the live status.
async function probe(url) {
  if (!url) return false;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    const r = await fetch(`${url.replace(/\/$/, '')}/health`, { signal: controller.signal });
    clearTimeout(timer);
    return r.ok;
  } catch (_) {
    return false;
  }
}

export async function GET(context) {
  const me = context.locals.user;
  if (!isStaffOrAbove(me.role)) return json({ error: 'Forbidden' }, 403);
  const raw = await dbCore.getSetting(SETTINGS_KEY);
  let value = { mode: 'stub' };
  if (raw) {
    try { value = JSON.parse(decryptSecret(raw)); } catch (_) { /* corrupt */ }
  }
  // Don't return the raw value of other settings here — just our mode.
  return json({ ok: true, mode: value.mode || 'stub' });
}

export async function POST(context) {
  const me = context.locals.user;
  if (!isStaffOrAbove(me.role)) return json({ error: 'Forbidden' }, 403);
  const body = await context.request.json().catch(() => null);
  const mode = body?.mode;
  if (!['hermes', 'cloud'].includes(mode)) {
    return json({ error: 'mode must be hermes or cloud.' }, 400);
  }
  const encrypted = encryptSecret(JSON.stringify({ mode }));
  await dbCore.setSetting(SETTINGS_KEY, encrypted, me.id);
  return json({ ok: true, mode });
}

// Used by the chat orchestrator: returns { mode, tunnelUrl? }. tunnelUrl
// is included so the orchestrator doesn't need to make a second DB call.
export async function getActiveChatSource() {
  // 'hermes' = the restaurant's own Hermes via the relay (no tunnel);
  // 'cloud' = the provider key in the AI card. Older saved values
  // ('hybrid', 'stub') mean Hermes now.
  const raw = await dbCore.getSetting(SETTINGS_KEY);
  let mode = 'hermes';
  if (raw) {
    try {
      const v = JSON.parse(decryptSecret(raw));
      mode = v.mode === 'cloud' ? 'cloud' : 'hermes';
    } catch (_) { /* corrupt: default */ }
  }
  return { mode };
}
