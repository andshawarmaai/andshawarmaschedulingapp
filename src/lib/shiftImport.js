// Shared row-validation + bulk-insert logic for CSV shift imports. Used by
// both the authenticated admin upload (api/admin/shift-imports) and the
// API-key upload (api/public/shift-imports) so an external agent's import
// is held to exactly the same rules as one uploaded through the UI.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;
const DEPARTMENTS = new Set(['', 'FOH', 'BOH']);

// Minimal CSV parser: handles quoted fields with embedded commas and ""
// escaped quotes, which is all the template format needs.
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') { inQuotes = false; }
      else { field += c; }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((f) => f !== '')) rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length > 0) { row.push(field); if (row.some((f) => f !== '')) rows.push(row); }
  if (rows.length === 0) return [];
  const header = rows[0].map((h) => h.trim().toLowerCase());
  return rows.slice(1).map((r) => {
    const obj = {};
    header.forEach((h, i) => { obj[h] = (r[i] || '').trim(); });
    return obj;
  });
}

// Validates every row against the roster before writing anything —
// all-or-nothing, so a bad upload never silently drops rows onto the
// calendar. Returns either { errors } or { resolved }.
export function validateShiftRows(rows, users) {
  const byUsername = new Map(users.map((u) => [u.username.toLowerCase(), u]));
  const errors = [];
  const resolved = [];

  rows.forEach((row, i) => {
    const line = i + 2; // +1 for 0-index, +1 for the header row
    const username = String(row.username || '').trim();
    const date = String(row.date || '').trim();
    const start_time = String(row.start_time || '').trim();
    const end_time = String(row.end_time || '').trim();
    const department = String(row.department || '').trim().toUpperCase();
    const notes = row.notes ? String(row.notes).trim() : null;

    const user = byUsername.get(username.toLowerCase());
    if (!username) errors.push(`Row ${line}: username is required.`);
    else if (!user) errors.push(`Row ${line}: no user with username "${username}".`);
    if (!DATE_RE.test(date)) errors.push(`Row ${line}: date must be YYYY-MM-DD (got "${date}").`);
    if (!TIME_RE.test(start_time)) errors.push(`Row ${line}: start_time must be HH:MM (got "${start_time}").`);
    if (!TIME_RE.test(end_time)) errors.push(`Row ${line}: end_time must be HH:MM (got "${end_time}").`);
    if (TIME_RE.test(start_time) && TIME_RE.test(end_time) && start_time >= end_time) {
      errors.push(`Row ${line}: start_time must be before end_time.`);
    }
    if (!DEPARTMENTS.has(department)) errors.push(`Row ${line}: department must be FOH, BOH, or blank (got "${department}").`);

    if (user && DATE_RE.test(date) && TIME_RE.test(start_time) && TIME_RE.test(end_time)) {
      resolved.push({ user_id: user.id, date, start_time, end_time, department: department || null, notes });
    }
  });

  return errors.length > 0 ? { errors } : { resolved };
}

// Runs validation then writes the import batch + its shifts. `db` is the
// storage backend (src/lib/db/index.js default export).
export async function runShiftImport(db, { rows, filename, uploaded_by }) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return { error: 'No rows to import.' };
  }
  if (rows.length > 1000) {
    return { error: 'Too many rows in one upload (max 1000).' };
  }

  const users = await db.listUsers();
  const { errors, resolved } = validateShiftRows(rows, users);
  if (errors) {
    return { error: 'Fix these rows and re-upload — nothing was imported.', rowErrors: errors.slice(0, 50) };
  }

  const importRow = await db.createShiftImport({
    uploaded_by: uploaded_by || null,
    filename: filename ? String(filename).slice(0, 200) : null,
    row_count: resolved.length,
  });
  for (const shift of resolved) {
    await db.createShift({ ...shift, import_id: importRow.id });
  }

  return { ok: true, import: importRow, count: resolved.length };
}
