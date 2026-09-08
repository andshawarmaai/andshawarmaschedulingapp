// Server-side auth gate. This runs for EVERY request before any page or API
// route executes — that's the fix for the old app's core bug, where auth was
// only checked by client-side JavaScript after the page had already loaded,
// so navigating straight to a URL like /schedule skipped the login screen
// entirely. Nothing here can be bypassed by typing a URL, because there is
// no page content to serve until this decides the request is allowed.

import { defineMiddleware } from 'astro:middleware';
import { verifySessionToken, SESSION_COOKIE } from './lib/session.js';

const ADMIN_ONLY_PREFIXES = ['/admin', '/api/users', '/api/admin'];
const STATIC_FILE = /\.[a-zA-Z0-9]+$/;

function isStaffOrAbove(role) {
  return role === 'admin' || role === 'manager';
}

export const onRequest = defineMiddleware(async (context, next) => {
  const { pathname } = context.url;

  // Let static assets (logo, css, bundled js, favicon) through untouched.
  if (pathname.startsWith('/_astro/') || STATIC_FILE.test(pathname)) {
    return next();
  }

  const token = context.cookies.get(SESSION_COOKIE)?.value ?? null;
  const user = token ? verifySessionToken(token) : null;
  context.locals.user = user;

  const isApi = pathname.startsWith('/api/');

  if (isApi) {
    if (pathname === '/api/auth/login' || pathname === '/api/auth/request-password-reset') return next();
    // API-key-authenticated routes do their own auth (see apiKey.js) —
    // they're reachable with no session cookie at all, by design.
    if (pathname.startsWith('/api/public/')) return next();
    // Telegram calls this with no session cookie either — it verifies the
    // request itself via the per-bot secret token (see
    // api/telegram/webhook/[id].js).
    if (pathname.startsWith('/api/telegram/webhook/')) return next();
    if (!user) {
      return jsonResponse({ error: 'Unauthorized' }, 401);
    }
    if (ADMIN_ONLY_PREFIXES.some((p) => pathname.startsWith(p)) && !isStaffOrAbove(user.role)) {
      return jsonResponse({ error: 'Forbidden' }, 403);
    }
    return next();
  }

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
