// Bulk shift import for external agents (an AI assistant, a bot, a script)
// — authenticated by an API key instead of the login-session cookie every
// other route uses. middleware.js exempts /api/public/ from the cookie
// check for exactly this reason; auth here is self-contained.
//
// Call it with:
//   Authorization: Bearer shwrm_xxxxxxxxxxxxxxxxxxxxxxxx
// and either:
//   Content-Type: text/csv            body = the raw CSV file content
//   Content-Type: application/json    body = { "filename": "...", "rows": [ {...}, ... ] }
//
// The CSV columns are exactly the downloadable template's columns:
// username,date,start_time,end_time,department,notes
import db from '../../../lib/db/index.js';
import { keyPrefix, verifyApiKeyHash } from '../../../lib/apiKey.js';
import { parseCsv, runShiftImport } from '../../../lib/shiftImport.js';

export const prerender = false;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

async function authenticate(context) {
  const auth = context.request.headers.get('authorization') || '';
  const match = auth.match(/^Bearer\s+(.+)$/i);
  const rawKey = match ? match[1].trim() : null;
  if (!rawKey || !rawKey.startsWith('shwrm_')) return null;

  const record = await db.findApiKeyByPrefix(keyPrefix(rawKey));
  if (!record) return null;
  if (!verifyApiKeyHash(rawKey, record.key_hash)) return null;
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
