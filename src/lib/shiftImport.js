// Shared row-validation + bulk-write logic for CSV schedule imports. Used
// by both the authenticated admin upload (api/admin/shift-imports) and the
// API-key upload (api/public/shift-imports) so an external agent's import
// is held to exactly the same rules as one uploaded through the UI.
//
// Multi-type format — a `type` column picks which kind of change a row
// makes, since one spoken request to an AI assistant ("add Jorge Tuesday
// 11-7, cap Friday lunch at 2 people, and put my Saturday shift up for
// swap") can span all three:
//   type=shift  username,date,start_time,end_time,notes
//   type=cap    date,window_start,window_end,max_shifts,notes
//   type=swap   username,date,start_time,notes   (notes = swap reason)

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;
const TYPES = new Set(['shift', 'cap', 'swap']);

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

// Builds the downloadable template: a comment block listing every valid
// username (so whatever AI is filling this out has an exact reference —
// no guessing at spelling), the column header, and one example row per
// type. Regenerated on every request, so it never goes stale as the
// roster changes.
export function buildTemplateCsv(users) {
  const usernames = users.filter((u) => !u.disabled).map((u) => u.username).sort();
  const lines = [
    '# Valid usernames: ' + usernames.join(', '),
    '# type=shift  -> username,date,start_time,end_time,notes',
    '# type=cap    -> date,window_start,window_end,max_shifts,notes',
    '# type=swap   -> username,date,start_time,notes (notes = reason; matches an EXISTING shift to post for swap)',
    '# Delete these comment lines and the example rows below before importing, or leave the comments — they are ignored.',
    'type,username,date,start_time,end_time,window_start,window_end,max_shifts,notes',
    `shift,${usernames[0] || 'username'},2026-09-15,11:00,19:00,,,,`,
    `cap,,2026-09-15,,,11:00,15:00,2,lunch rush`,
    `swap,${usernames[0] || 'username'},2026-09-15,11:00,,,,,can't make it`,
  ];
  return lines.join('\n') + '\n';
}

// Validates every row before writing anything — all-or-nothing, so a bad
// upload never silently drops or partially applies rows. `users` and
// `shifts` are the current flat tables (needed to resolve a swap row's
// username+date+start_time down to an existing shift id).
export function validateImportRows(rows, { users, shifts }) {
  const byUsername = new Map(users.map((u) => [u.username.toLowerCase(), u]));
  const errors = [];
  const resolved = { shifts: [], caps: [], swaps: [] };

  rows.forEach((row, i) => {
    const line = i + 2; // +1 for 0-index, +1 for the header row
    const type = String(row.type || 'shift').trim().toLowerCase();
    if (!TYPES.has(type)) {
      errors.push(`Row ${line}: type must be "shift", "cap", or "swap" (got "${type}").`);
      return;
    }

    if (type === 'shift') {
      const username = String(row.username || '').trim();
      const date = String(row.date || '').trim();
      const start_time = String(row.start_time || '').trim();
      const end_time = String(row.end_time || '').trim();
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
    const user = byUsername.get(username.toLowerCase());
    if (!username) errors.push(`Row ${line}: username is required.`);
    else if (!user) errors.push(`Row ${line}: no user with username "${username}".`);
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
// revert to), and swap posts (also not batch-undoable — cancelling a post
// is a distinct business action, done from the Shift Swap board).
export async function runShiftImport(db, { rows, filename, uploaded_by }) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return { error: 'No rows to import.' };
  }
  if (rows.length > 1000) {
    return { error: 'Too many rows in one upload (max 1000).' };
  }

  const [users, shifts] = await Promise.all([db.listUsers(), db.listShifts()]);
  const { errors, resolved } = validateImportRows(rows, { users, shifts });
  if (errors) {
    return { error: 'Fix these rows and re-upload — nothing was imported.', rowErrors: errors.slice(0, 50) };
  }

  const totalCount = resolved.shifts.length + resolved.caps.length + resolved.swaps.length;
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

  return {
    ok: true,
    import: importRow,
    count: totalCount,
    breakdown: { shifts: resolved.shifts.length, caps: resolved.caps.length, swaps: resolved.swaps.length },
  };
}
