// Bulk schedule import for external agents (an AI assistant, a bot, a
// script) — authenticated by an API key instead of the login-session
// cookie every other route uses. middleware.js exempts /api/public/ from
// the cookie check for exactly this reason; auth here is self-contained.
//
// Call it with:
//   Authorization: Bearer shwrm_xxxxxxxxxxxxxxxxxxxxxxxx
// and either:
//   Content-Type: text/csv            body = the raw CSV file content
//   Content-Type: application/json    body = { "filename": "...", "rows": [ {...}, ... ] }
//
// Rows use the `type` column to pick shift / cap / swap — see
// src/lib/shiftImport.js buildTemplateCsv() for the exact columns, or
// download the live template from Manage -> Bulk Schedule Import.
import db from '../../../lib/db/index.js';
import { keyPrefix, verifyApiKeyHash } from '../../../lib/apiKey.js';
import { parseCsv, runShiftImport } from '../../../lib/shiftImport.js';

export const prerender = false;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

// Logs exactly which check failed (visible in Vercel's function logs) —
// a 401 here gives the caller nothing to go on, so this is the only way
// to tell "no header sent" apart from "key revoked" apart from "hash
// mismatch" after the fact instead of re-deriving it live.
async function authenticate(context) {
  const auth = context.request.headers.get('authorization') || '';
  const match = auth.match(/^Bearer\s+(.+)$/i);
  const rawKey = match ? match[1].trim() : null;
  if (!rawKey || !rawKey.startsWith('shwrm_')) {
    console.error('[api/public/shift-imports] auth rejected: no Bearer token with the expected "shwrm_" prefix');
    return null;
  }

  const prefix = keyPrefix(rawKey);
  const record = await db.findApiKeyByPrefix(prefix);
  if (!record) {
    console.error(`[api/public/shift-imports] auth rejected: no active key found for prefix ${prefix} (never existed, or was revoked)`);
    return null;
  }
  if (!verifyApiKeyHash(rawKey, record.key_hash)) {
    console.error(`[api/public/shift-imports] auth rejected: hash mismatch for key ${record.label} (${prefix}) — token doesn't match what was issued`);
    return null;
  }
  return record;
}

export async function POST(context) {
  const key = await authenticate(context);
  if (!key) {
    return json({ error: 'Missing or invalid API key. Send "Authorization: Bearer <key>".' }, 401);
  }

  const contentType = context.request.headers.get('content-type') || '';
  let rows, filename;
  if (contentType.includes('application/json')) {
    const body = await context.request.json().catch(() => null);
    rows = body && Array.isArray(body.rows) ? body.rows : null;
    filename = body && body.filename;
  } else {
    const text = await context.request.text();
    rows = parseCsv(text);
  }

  if (!rows || rows.length === 0) {
    return json({ error: 'No rows found. Send raw CSV (Content-Type: text/csv) or JSON { rows: [...] }.' }, 400);
  }

  const result = await runShiftImport(db, { rows, filename: filename || `api:${key.label}`, uploaded_by: key.created_by });
  await db.touchApiKey(key.id);

  if (result.error) return json(result, 400);
  return json(result, 201);
}
