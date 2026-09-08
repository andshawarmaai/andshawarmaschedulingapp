// Server-only signed session tokens. Payload is base64url JSON, HMAC-signed
// with SESSION_SECRET so the role/user fields can never be forged client-side
// (the old app just base64-encoded JSON with no signature at all).

import crypto from 'node:crypto';

export const SESSION_COOKIE = 'shawarma_session';
export const SESSION_MAX_AGE = 60 * 60 * 24 * 30; // 30 days, seconds

function getSecret() {
  const secret = process.env.SESSION_SECRET;
  if (secret) return secret;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('SESSION_SECRET environment variable must be set in production.');
  }
  return 'dev-only-insecure-secret-do-not-use-in-production';
}

function sign(payloadB64) {
  return crypto.createHmac('sha256', getSecret()).update(payloadB64).digest('base64url');
}

export function createSessionToken(user) {
  const payload = {
    id: user.id,
    username: user.username,
    role: user.role,
    display_name: user.display_name,
    exp: Math.floor(Date.now() / 1000) + SESSION_MAX_AGE,
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${payloadB64}.${sign(payloadB64)}`;
}

export function verifySessionToken(token) {
  if (!token || typeof token !== 'string') return null;
  const dot = token.indexOf('.');
  if (dot < 0) return null;
  const payloadB64 = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = sign(payloadB64);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}
