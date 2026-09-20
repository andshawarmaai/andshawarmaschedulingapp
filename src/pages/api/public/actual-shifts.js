// Sprint 7 (PRD EPIC 11 subset) — actual worked time, POS/timeclock-
// agnostic. Same auth pattern as /api/public/shift-imports.js (API key,
// exempted from the cookie check by middleware.js) and the same
// division of labor: whatever POS/timeclock system a given business
// actually uses, translating ITS report format into this endpoint's one
// canonical row shape is the calling agent's job, not a per-vendor
// adapter maintained here — see AGENT-TRAINING.md's "a dropped-in file is
// yours to convert" principle.
//
// Call it with:
//   Authorization: Bearer shwrm_xxxxxxxxxxxxxxxxxxxxxxxx
//   Content-Type: application/json
//   body = { "source": "toast", "rows": [ { user_id, date, clock_in, clock_out?, external_ref?, shift_id? }, ... ] }
import db from '../../../lib/db/index.js';
import { keyPrefix, verifyApiKeyHash } from '../../../lib/apiKey.js';

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

const TIME_RE = /^\d{2}:\d{2}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function POST(context) {
  const key = await authenticate(context);
  if (!key) return json({ error: 'Missing or invalid API key. Send "Authorization: Bearer <key>".' }, 401);

  const body = await context.request.json().catch(() => null);
  const source = body && body.source ? String(body.source).trim().toLowerCase() : null;
  const rows = body && Array.isArray(body.rows) ? body.rows : null;
  if (!source) return json({ error: 'source is required (e.g. "toast", "square", "clover", "manual") — whatever system this data actually came from.' }, 400);
  if (!rows || rows.length === 0) return json({ error: 'rows (a non-empty array) is required.' }, 400);
  if (rows.length > 1000) return json({ error: 'Too many rows in one call (max 1000).' }, 400);

  const [users, shifts] = await Promise.all([db.listUsers(), db.listShifts()]);
  const usersById = new Set(users.map((u) => u.id));

  // Validate everything before writing anything — an all-or-nothing batch,
  // same discipline runShiftImport() already uses for bulk shift rows.
  const rowErrors = [];
  rows.forEach((r, i) => {
    if (!r.user_id || !usersById.has(r.user_id)) rowErrors.push({ row: i, error: 'user_id missing or unknown — resolve via GET /api/state → users first.' });
    if (!r.date || !DATE_RE.test(r.date)) rowErrors.push({ row: i, error: 'date must be YYYY-MM-DD.' });
    if (!r.clock_in || !TIME_RE.test(r.clock_in)) rowErrors.push({ row: i, error: 'clock_in must be HH:MM (24h).' });
    if (r.clock_out !== undefined && r.clock_out !== null && !TIME_RE.test(r.clock_out)) rowErrors.push({ row: i, error: 'clock_out, if given, must be HH:MM (24h).' });
    if (r.shift_id && !shifts.some((s) => s.id === r.shift_id)) rowErrors.push({ row: i, error: 'shift_id does not match any known shift — omit it rather than guessing.' });
  });
  if (rowErrors.length > 0) return json({ error: 'Fix these rows and resubmit — nothing was imported.', rowErrors: rowErrors.slice(0, 50) }, 400);

  const importRow = await db.createShiftImport({ uploaded_by: key.created_by, filename: `actual-shifts:${source}:${key.label}`, row_count: rows.length });

  let created = 0;
  let skippedDuplicate = 0;
  for (const r of rows) {
    if (r.external_ref) {
      const existing = await db.findActualWorkedShiftBySourceRef(source, String(r.external_ref));
      if (existing) { skippedDuplicate++; continue; }
    }
    await db.createActualWorkedShift({
      user_id: r.user_id, shift_id: r.shift_id || null, date: r.date, clock_in: r.clock_in, clock_out: r.clock_out || null,
      source, external_ref: r.external_ref ? String(r.external_ref) : null, import_id: importRow.id,
    });
    created++;
  }
  await db.touchApiKey(key.id);

  return json({ ok: true, created, skippedDuplicate, import_id: importRow.id }, 201);
}
