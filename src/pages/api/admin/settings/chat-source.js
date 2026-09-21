// Chat source configuration — picks WHERE the orchestrator sends
// messages. The owner (admin) picks this in the Settings panel, no env
// vars or redeploys needed.
//
// Modes:
//   - 'hermes'      — POST every message to the tunnel URL (free, runs
//                      on the admin's Mac via hermes-bridge.mjs).
//                      The tunnel URL is set via the Tunnel card.
//   - 'cloud'       — Use the Chat Bot cloud provider (Claude / OpenAI
//                      / MiniMax) configured in the AI card. Billed per
//                      token.
//   - 'hybrid'      — Try Hermes first; if the tunnel doesn't respond
//                      within ~2s, automatically fall back to cloud.
//                      Default choice when both are set up.
//   - 'stub'        — No AI at all; the orchestrator replies with
//                      helpful plain-language stub messages.
//
// One row in app_settings: key='chat_source', value JSON:
//   { mode: 'hermes'|'cloud'|'hybrid'|'stub' }

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
  if (!['hermes', 'cloud', 'hybrid', 'stub'].includes(mode)) {
    return json({ error: 'mode must be one of: hermes, cloud, hybrid, stub.' }, 400);
  }
  const encrypted = encryptSecret(JSON.stringify({ mode }));
  await dbCore.setSetting(SETTINGS_KEY, encrypted, me.id);
  return json({ ok: true, mode });
}

// Used by the chat orchestrator: returns { mode, tunnelUrl? }. tunnelUrl
// is included so the orchestrator doesn't need to make a second DB call.
export async function getActiveChatSource() {
  const raw = await dbCore.getSetting(SETTINGS_KEY);
  let mode = 'stub';
  if (raw) {
    try {
      const v = JSON.parse(decryptSecret(raw));
      mode = v.mode || 'stub';
    } catch (_) { /* corrupt */ }
  }
  // Lazily import to avoid a circular dep
  const { getActiveTunnelUrl } = await import('./tunnel.js');
  const tunnelUrl = await getActiveTunnelUrl();
  return { mode, tunnelUrl };
}
