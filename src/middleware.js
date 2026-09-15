// Server-side auth gate. This runs for EVERY request before any page or API
// route executes — that's the fix for the old app's core bug, where auth was
// only checked by client-side JavaScript after the page had already loaded,
// so navigating straight to a URL like /schedule skipped the login screen
// entirely. Nothing here can be bypassed by typing a URL, because there is
// no page content to serve until this decides the request is allowed.

import { defineMiddleware } from 'astro:middleware';
import { verifySessionToken, SESSION_COOKIE } from './lib/session.js';
import { keyPrefix, verifyApiKeyHash } from './lib/apiKey.js';
import db from './lib/db/index.js';

const ADMIN_ONLY_PREFIXES = ['/admin', '/api/users', '/api/admin'];
const STATIC_FILE = /\.[a-zA-Z0-9]+$/;

function isStaffOrAbove(role) {
  return role === 'admin' || role === 'manager';
}

// Two ways to authenticate an API request: a signed session cookie
// (browser), or an API key in an Authorization: Bearer header (programmatic
// access — this is how an external agent, e.g. Hermes, drives the app). An
// API key acts AS the user who created it, with that user's real role —
// there is no separate "service account" concept, so every existing
// role-gated route below works for an API-key caller with zero per-route
// changes, and every write is still correctly attributed to a real person.
// /api/public/shift-imports.js predates this and does its own equivalent
// check inline — left as-is rather than migrated, since it already works.
async function resolveApiKeyUser(context) {
  const auth = context.request.headers.get('authorization') || '';
  const match = /^Bearer\s+(shwrm_\S+)$/.exec(auth.trim());
  if (!match) return null;
  const rawKey = match[1];
  const record = await db.findApiKeyByPrefix(keyPrefix(rawKey));
  if (!record || record.revoked) return null;
  if (!verifyApiKeyHash(rawKey, record.key_hash)) return null;
  const owner = await db.getUserById(record.created_by);
  if (!owner || owner.disabled) return null;
  db.touchApiKey(record.id).catch(() => {});
  return { id: owner.id, username: owner.username, role: owner.role, display_name: owner.display_name, apiKeyId: record.id };
}

export const onRequest = defineMiddleware(async (context, next) => {
  const { pathname } = context.url;

  // Let static assets (logo, css, bundled js, favicon) through untouched.
  if (pathname.startsWith('/_astro/') || STATIC_FILE.test(pathname)) {
    return next();
  }

  const token = context.cookies.get(SESSION_COOKIE)?.value ?? null;
  let user = token ? verifySessionToken(token) : null;

  const isApi = pathname.startsWith('/api/');

  if (isApi) {
    if (pathname === '/api/auth/login' || pathname === '/api/auth/request-password-reset') return next();
    // /api/public/ routes do their own auth (see apiKey.js) — reachable
    // with no session cookie at all, by design. /api/agent-guide is pure
    // documentation (same content as the committed AGENT-TRAINING.md) —
    // an agent should be able to read how to integrate before it
    // necessarily has a key yet.
    if (pathname.startsWith('/api/public/') || pathname.startsWith('/api/agent-guide')) return next();
    if (!user) user = await resolveApiKeyUser(context);
    if (!user) {
      return jsonResponse({ error: 'Unauthorized' }, 401);
    }
    context.locals.user = user;
    if (ADMIN_ONLY_PREFIXES.some((p) => pathname.startsWith(p)) && !isStaffOrAbove(user.role)) {
      return jsonResponse({ error: 'Forbidden' }, 403);
    }
    return next();
  }

  context.locals.user = user;

  // Page routes.
  if (pathname === '/login') {
    if (user) return context.redirect('/', 302);
    return next();
  }

  if (!user) {
    return context.redirect('/login', 302);
  }

  if (pathname.startsWith('/admin') && !isStaffOrAbove(user.role)) {
    return context.redirect('/', 302);
  }

  return next();
});

function jsonResponse(data, status) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
