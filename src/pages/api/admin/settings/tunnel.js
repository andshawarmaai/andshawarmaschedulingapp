// Settings for the optional local-Hermes tunnel. When AGENT_TUNNEL_URL is
// set and reachable, chat messages go through the tunnel (calls back to
// the user's Mac running hermes-bridge.mjs — free, AI runs on the user's
// own API key). When the tunnel is unreachable, the chat falls back to
// the Chat Bot cloud provider configured in app_settings.
//
// GET  — returns { tunnel_url, mode: 'tunnel'|'cloud'|'offline', reachable }
// POST — { tunnel_url } to set the URL
// DELETE — clears the URL

import dbCore from '../../../../lib/db/index.js';
import { encryptSecret, decryptSecret } from '../../../../lib/settingsCrypto.js';

export const prerender = false;

const TUNNEL_KEY = 'agent_tunnel_url';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function isStaffOrAbove(role) {
  return role === 'admin' || role === 'manager';
}

// Quick health check — the tunnel exposes /health on the bridge. If it
// responds within 2s we treat it as reachable.
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
  const raw = await dbCore.getSetting(TUNNEL_KEY);
  let tunnelUrl = null;
  if (raw) {
    try { tunnelUrl = decryptSecret(raw); } catch (_) { /* corrupt — ignore */ }
  }
  const reachable = await probe(tunnelUrl);
  // Determine mode: tunnel + reachable → tunnel; tunnel + unreachable → offline; no tunnel → cloud
  let mode = 'cloud';
  if (tunnelUrl) mode = reachable ? 'tunnel' : 'offline';
  return json({ ok: true, tunnel_url: tunnelUrl, reachable, mode });
}

export async function POST(context) {
  const me = context.locals.user;
  if (!isStaffOrAbove(me.role)) return json({ error: 'Forbidden' }, 403);
  const body = await context.request.json().catch(() => null);
  const url = (body?.tunnel_url || '').trim();
  if (!url) return json({ error: 'tunnel_url is required.' }, 400);
  if (!/^https:\/\//.test(url)) return json({ error: 'tunnel_url must start with https://' }, 400);
  const reachable = await probe(url);
  // Probe failure no longer blocks saves — Tailscale Funnel may be reachable
  // from real browsers but time out from Vercel's edge. Save anyway, the
  // orchestrator's first real message will retry and surface any issue.
  const encrypted = encryptSecret(url);
  await dbCore.setSetting(TUNNEL_KEY, encrypted, me.id);
  return json({ ok: true, tunnel_url: url, reachable, mode: reachable ? 'tunnel' : 'offline' });
}

export async function DELETE(context) {
  const me = context.locals.user;
  if (!isStaffOrAbove(me.role)) return json({ error: 'Forbidden' }, 403);
  await dbCore.deleteSetting(TUNNEL_KEY);
  return json({ ok: true });
}

// Helper used by the chat orchestrator: returns the tunnel URL if set,
// null otherwise. The orchestrator decides whether to use it or fall
// back to the Chat Bot cloud provider.
//
// FALLBACK ORDER: (1) `TUNNEL_URL` env var (plaintext, no DB needed),
// (2) DB row (`agent_tunnel_url`, encrypted with SESSION_SECRET),
// (3) `null` (orchestrator falls back to the cloud chat-bot provider).
// The env var path is useful when the DB row is wrong or the deploy
// environment doesn't have SESSION_SECRET, but it does NOT bypass auth
// — anyone who can set env vars in this project already has full access.
export async function getActiveTunnelUrl() {
  if (process.env.TUNNEL_URL && /^https?:\/\//.test(process.env.TUNNEL_URL)) {
    return process.env.TUNNEL_URL;
  }
  const raw = await dbCore.getSetting(TUNNEL_KEY);
  if (!raw) return null;
  try { return decryptSecret(raw); } catch (_) { return null; }
}
