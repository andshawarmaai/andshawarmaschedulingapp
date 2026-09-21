// AES-256-GCM encryption for stored secrets (AI provider API keys etc).
// Key is derived from SESSION_SECRET via PBKDF2 — the same SESSION_SECRET
// the rest of the app already throws on boot without, so this is no
// new deployment requirement.
//
// All app_settings.value_encrypted bytes are opaque to anyone who
// doesn't have SESSION_SECRET (i.e. anyone with read-only DB access).
//
// Format: { 12-byte IV || ciphertext || 16-byte auth-tag } — standard
// Node crypto AES-256-GCM output.

import crypto from 'node:crypto';

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;
const PBKDF2_ITER = 100_000;

let cachedKey = null;

function getKey() {
  if (cachedKey) return cachedKey;
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error('SESSION_SECRET is not set — cannot encrypt secrets. Set it in your env (.env.local in dev, Vercel project env in production).');
  }
  cachedKey = crypto.pbkdf2Sync(secret, 'and-shawarma-settings-salt', PBKDF2_ITER, KEY_LEN, 'sha256');
  return cachedKey;
}

export function encryptSecret(plaintext) {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { value_encrypted: ct, iv, auth_tag: tag };
}

export function decryptSecret({ value_encrypted, iv, auth_tag }) {
  const key = getKey();
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(auth_tag);
  const pt = Buffer.concat([decipher.update(value_encrypted), decipher.final()]);
  return pt.toString('utf8');
}
