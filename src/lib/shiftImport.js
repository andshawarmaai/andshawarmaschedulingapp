// Shared row-validation + bulk-write logic for CSV schedule imports. Used
// by both the authenticated admin upload (api/admin/shift-imports) and the
// API-key upload (api/public/shift-imports) so an external agent's import
// is held to exactly the same rules as one uploaded through the UI.
//
// Multi-type format — a `type` column picks which kind of change a row
// makes, since one spoken request to an AI assistant ("add Jorge Tuesday
// 11-7, cap Friday lunch at 2 people, put my Saturday shift up for swap,
// and set up a recurring 9-6 opener template") can span all four:
//   type=shift     username,date,start_time,end_time,notes
//   type=cap       date,window_start,window_end,max_shifts,notes
//   type=swap      username,date,start_time,notes   (notes = swap reason)
//   type=template  name,days_of_week,start_time,end_time,min_staff,max_staff
//                  (days_of_week: 0-6, comma/space/pipe separated; matched
//                  by exact `name` — importing the same name again UPDATES
//                  it in place instead of creating a duplicate template)

import { parseDaysOfWeek, parseStaffCount } from './shiftTemplateFields.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;
const TYPES = new Set(['shift', 'cap', 'swap', 'template']);
const AMBIGUOUS = Symbol('ambiguous');

// Whoever fills out the sheet (a person speaking to an AI) is far more
// likely to say "Ray" or "Ray Ally" than the system username "ray" — so a
// row's name column matches against username, full display name, OR first
// name, not just the exact username.
//
// Usernames are kept in their own map, checked first and always exact:
// they're unique by database constraint, so one can never be ambiguous.
// Display names and first names go in a separate "fuzzy" index where a
// collision (two people named "Jorge") poisons that one key to AMBIGUOUS
// rather than guessing — critically, that poisoning must never be able to
// reach into the username map, or a first-name collision with an unrelated
// person could break someone's own exact, unique username.
function buildNameIndex(users) {
  const usernames = new Map(users.map((u) => [u.username.trim().toLowerCase(), u]));
  const fuzzy = new Map();
  const add = (key, user) => {
    const k = String(key || '').trim().toLowerCase();
    if (!k) return;
    if (fuzzy.has(k) && fuzzy.get(k) !== user) fuzzy.set(k, AMBIGUOUS);
    else if (!fuzzy.has(k)) fuzzy.set(k, user);
  };
  for (const u of users) {
    add(u.display_name, u);
    add(String(u.display_name || '').split(' ')[0], u);
  }
  return { usernames, fuzzy };
}

// Returns the matched user, or null (not found / ambiguous — the caller
// doesn't need to tell those apart for the error message).
function resolveUser({ usernames, fuzzy }, raw) {
  const k = String(raw || '').trim().toLowerCase();
  const exact = usernames.get(k);
  if (exact) return exact;
  const hit = fuzzy.get(k);
  return hit && hit !== AMBIGUOUS ? hit : null;
}

// Minimal CSV parser: skips blank lines and "#" comment lines (so a
// generated template can carry a human/AI-readable reference block above
// the header row), and handles quoted fields with embedded commas and ""
// escaped quotes.
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const pushRow = () => {
    if (row.some((f) => f !== '')) rows.push(row);
    row = [];
  };
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
      pushRow();
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length > 0) { row.push(field); pushRow(); }

  // Drop comment lines (a raw line whose first cell starts with "#") before
  // treating the first remaining line as the header.
  const dataRows = rows.filter((r) => !(r[0] || '').trim().startsWith('#'));
  if (dataRows.length === 0) return [];
  const header = dataRows[0].map((h) => h.trim().toLowerCase());
  return dataRows.slice(1).map((r) => {
    const obj = {};
    header.forEach((h, i) => { obj[h] = (r[i] || '').trim(); });
    return obj;
  });
}

// Builds the downloadable template. Each staff member gets their OWN
// comment line ("# adnan -> Adnan") rather than one giant comma-packed
// line — a spreadsheet app (Excel, Numbers, Sheets) splits on every comma
// regardless of "#", so a single line listing everyone turns into a wall
// of misaligned cells that doesn't read as a roster at all. One name per
// line stays readable there and is still just as invisible to the
// machine parser (anything starting with "#" is dropped either way).
// The `username` column below accepts username, full name, or first name
// (see buildNameIndex) — this list is only a spelling reference.
export function buildTemplateCsv(users) {
  const active = users.filter((u) => !u.disabled).sort((a, b) => a.username.localeCompare(b.username));
  const exampleName = active[0] ? active[0].display_name : 'username or full name';
  const lines = [
    '# ===== STAFF ROSTER — use the exact spelling of either name below in the "username" column =====',
    ...active.map((u) => `# ${u.username} -> ${u.display_name}`),
    '# ===== If two people share a first name, use their full name or username instead =====',
    '#',
    '# type=shift     -> username,date,start_time,end_time,notes',
    '# type=cap       -> date,window_start,window_end,max_shifts,notes',
    '# type=swap      -> username,date,start_time,notes (notes = reason; matches an EXISTING shift to post for swap)',
    '# type=template  -> name,days_of_week,start_time,end_time,min_staff,max_staff',
    '#                   days_of_week: 0=Sun..6=Sat, separated by comma, space, or "|" (e.g. "1 2 3 4 5" or "5|6")',
    '#                   Matched by exact name — importing the same name again UPDATES it instead of duplicating it.',
    '# Delete these comment lines and the example rows below before importing, or leave the comments — they are ignored.',
    'type,username,name,date,start_time,end_time,days_of_week,min_staff,max_staff,window_start,window_end,max_shifts,notes',
    `shift,${exampleName},,2026-09-15,11:00,19:00,,,,,,,`,
    `cap,,,2026-09-15,,,,,,11:00,15:00,2,lunch rush`,
    `swap,${exampleName},,2026-09-15,11:00,,,,,,,,can't make it`,
    `template,,Opener,,09:00,15:00,1 2 3 4 5,,1,,,,`,
  ];
  return lines.join('\n') + '\n';
}

// Validates every row before writing anything — all-or-nothing, so a bad
// upload never silently drops or partially applies rows. `users` and
// `shifts` are the current flat tables (needed to resolve a swap row's
// username+date+start_time down to an existing shift id).
export function validateImportRows(rows, { users, shifts }) {
  const nameIndex = buildNameIndex(users);
  const errors = [];
  const resolved = { shifts: [], caps: [], swaps: [], templates: [] };

  rows.forEach((row, i) => {
    const line = i + 2; // +1 for 0-index, +1 for the header row
    const type = String(row.type || 'shift').trim().toLowerCase();
    if (!TYPES.has(type)) {
      errors.push(`Row ${line}: type must be "shift", "cap", "swap", or "template" (got "${type}").`);
      return;
    }

    if (type === 'template') {
      const name = String(row.name || '').trim();
      const days_of_week = parseDaysOfWeek(row.days_of_week);
      const start_time = String(row.start_time || '').trim();
      const end_time = String(row.end_time || '').trim();
      const minParsed = parseStaffCount(row.min_staff);
      const maxParsed = parseStaffCount(row.max_staff);
      if (!name) errors.push(`Row ${line}: name is required.`);
      if (!days_of_week) errors.push(`Row ${line}: days_of_week must list at least one day, 0 (Sun) through 6 (Sat) — comma, space, or "|" separated.`);
      if (!TIME_RE.test(start_time)) errors.push(`Row ${line}: start_time must be HH:MM (got "${start_time}").`);
      if (!TIME_RE.test(end_time)) errors.push(`Row ${line}: end_time must be HH:MM (got "${end_time}").`);
      if (!minParsed.ok) errors.push(`Row ${line}: min_staff must be a whole number ≥ 0, or blank (got "${row.min_staff}").`);
      if (!maxParsed.ok) errors.push(`Row ${line}: max_staff must be a whole number ≥ 0, or blank (got "${row.max_staff}").`);
      if (name && days_of_week && TIME_RE.test(start_time) && TIME_RE.test(end_time) && minParsed.ok && maxParsed.ok) {
        resolved.templates.push({ name, days_of_week, start_time, end_time, min_staff: minParsed.value, max_staff: maxParsed.value });
      }
      return;
    }

    if (type === 'shift') {
      const username = String(row.username || '').trim();
      const date = String(row.date || '').trim();
      const start_time = String(row.start_time || '').trim();
      const end_time = String(row.end_time || '').trim();
      const notes = row.notes ? String(row.notes).trim() : null;
      const user = resolveUser(nameIndex, username);
      if (!username) errors.push(`Row ${line}: username is required.`);
      else if (!user) errors.push(`Row ${line}: "${username}" doesn't match exactly one staff member — check the roster list at the top of the template.`);
      if (!DATE_RE.test(date)) errors.push(`Row ${line}: date must be YYYY-MM-DD (got "${date}").`);
      if (!TIME_RE.test(start_time)) errors.push(`Row ${line}: start_time must be HH:MM (got "${start_time}").`);
      if (!TIME_RE.test(end_time)) errors.push(`Row ${line}: end_time must be HH:MM (got "${end_time}").`);
      // start_time >= end_time is allowed on purpose — it means the shift
      // crosses midnight (e.g. 16:30-02:30), a real shape some businesses
      // use for a closing shift. `date` is always the day the shift starts.
      if (user && DATE_RE.test(date) && TIME_RE.test(start_time) && TIME_RE.test(end_time)) {
        resolved.shifts.push({ user_id: user.id, date, start_time, end_time, notes });
      }
      return;
    }

    if (type === 'cap') {
      const date = String(row.date || '').trim();
      const window_start = String(row.window_start || '').trim();
      const window_end = String(row.window_end || '').trim();
      const max_shifts = Number(row.max_shifts);
      const note = row.notes ? String(row.notes).trim() : null;
      if (!DATE_RE.test(date)) errors.push(`Row ${line}: date must be YYYY-MM-DD (got "${date}").`);
      if (!TIME_RE.test(window_start)) errors.push(`Row ${line}: window_start must be HH:MM (got "${window_start}").`);
      if (!TIME_RE.test(window_end)) errors.push(`Row ${line}: window_end must be HH:MM (got "${window_end}").`);
      if (TIME_RE.test(window_start) && TIME_RE.test(window_end) && window_start >= window_end) {
        errors.push(`Row ${line}: window_start must be before window_end.`);
      }
      if (!Number.isInteger(max_shifts) || max_shifts < 0) errors.push(`Row ${line}: max_shifts must be a whole number ≥ 0 (got "${row.max_shifts}").`);
      if (DATE_RE.test(date) && TIME_RE.test(window_start) && TIME_RE.test(window_end) && Number.isInteger(max_shifts) && max_shifts >= 0) {
        resolved.caps.push({ date, window_start, window_end, max_shifts, note });
      }
      return;
    }

    // swap
    const username = String(row.username || '').trim();
    const date = String(row.date || '').trim();
    const start_time = String(row.start_time || '').trim();
    const reason = row.notes ? String(row.notes).trim() : null;
    const user = resolveUser(nameIndex, username);
    if (!username) errors.push(`Row ${line}: username is required.`);
    else if (!user) errors.push(`Row ${line}: "${username}" doesn't match exactly one staff member — check the roster list at the top of the template.`);
    if (!DATE_RE.test(date)) errors.push(`Row ${line}: date must be YYYY-MM-DD (got "${date}").`);
    if (!TIME_RE.test(start_time)) errors.push(`Row ${line}: start_time must be HH:MM (got "${start_time}").`);
    if (user && DATE_RE.test(date) && TIME_RE.test(start_time)) {
      const shift = shifts.find((s) => s.user_id === user.id && s.date === date && s.start_time === start_time);
      if (!shift) errors.push(`Row ${line}: no shift found for ${username} on ${date} at ${start_time} to post for swap.`);
      else resolved.swaps.push({ shift_id: shift.id, user_id: user.id, reason });
    }
  });

  return errors.length > 0 ? { errors } : { resolved };
}

// Runs validation then writes everything: shifts (tagged to the import
// batch, so "remove upload" can undo them), day caps (upserted directly —
// not batch-undoable, since a cap upsert has no clean prior state to
// revert to), swap posts (also not batch-undoable — cancelling a post is a
// distinct business action, done from the Shift Swap board), and shift
// templates (upserted by exact name against the roster snapshot taken
// before this loop — two new-template rows in the same batch that happen
// to share a name won't see each other, an accepted edge case rather than
// worth a second DB round-trip per row).
export async function runShiftImport(db, { rows, filename, uploaded_by }) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return { error: 'No rows to import.' };
  }
  if (rows.length > 1000) {
    return { error: 'Too many rows in one upload (max 1000).' };
  }

  const [users, shifts, shiftTemplates] = await Promise.all([db.listUsers(), db.listShifts(), db.listShiftTemplates()]);
  const { errors, resolved } = validateImportRows(rows, { users, shifts });
  if (errors) {
    return { error: 'Fix these rows and re-upload — nothing was imported.', rowErrors: errors.slice(0, 50) };
  }

  const totalCount = resolved.shifts.length + resolved.caps.length + resolved.swaps.length + resolved.templates.length;
  const importRow = await db.createShiftImport({
    uploaded_by: uploaded_by || null,
    filename: filename ? String(filename).slice(0, 200) : null,
    row_count: totalCount,
  });
  for (const shift of resolved.shifts) {
    await db.createShift({ ...shift, import_id: importRow.id });
  }
  for (const cap of resolved.caps) {
    await db.upsertDayCap(cap);
  }
  for (const swap of resolved.swaps) {
    await db.createSwapPost(swap);
  }
  let templatesCreated = 0;
  let templatesUpdated = 0;
  for (const tpl of resolved.templates) {
    const existing = shiftTemplates.find((t) => t.name.trim().toLowerCase() === tpl.name.trim().toLowerCase());
    if (existing) {
      await db.updateShiftTemplate(existing.id, tpl);
      templatesUpdated++;
    } else {
      await db.createShiftTemplate(tpl);
      templatesCreated++;
    }
  }

  return {
    ok: true,
    import: importRow,
    count: totalCount,
    breakdown: {
      shifts: resolved.shifts.length,
      caps: resolved.caps.length,
      swaps: resolved.swaps.length,
      templates: resolved.templates.length,
    },
    templatesCreated,
    templatesUpdated,
  };
}
