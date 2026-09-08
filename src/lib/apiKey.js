// API key generation + verification. Keys look like "shwrm_<32 random chars>".
// Only a bcrypt hash and a short prefix (for fast lookup + display, e.g.
// "shwrm_a1b2c3d4") are ever stored — the full key is only ever known at
// creation time, same as a password reset flow.
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';

const PREFIX_LEN = 14; // "shwrm_" + 8 chars, enough to disambiguate without leaking the secret

export function generateApiKey() {
  const raw = 'shwrm_' + crypto.randomBytes(24).toString('base64url');
  return raw;
}

export function keyPrefix(rawKey) {
  return rawKey.slice(0, PREFIX_LEN);
}

export function hashApiKey(rawKey) {
  return bcrypt.hashSync(rawKey, 10);
}

export function verifyApiKeyHash(rawKey, hash) {
  return bcrypt.compareSync(rawKey, hash);
}
