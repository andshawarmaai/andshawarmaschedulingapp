// Shared field parsing for shift_templates — used by the admin API routes
// (api/admin/shift-templates/*) AND the bulk-import `template` row type
// (shiftImport.js), so a CSV/JSON import is held to exactly the same rules
// as one entered through the Manage UI. Previously these two functions
// were duplicated between the POST and PATCH route files (identically, so
// no drift yet) — pulled out here as a third caller was about to make that
// a three-way duplication.

// Splits on comma, whitespace, or "|" — not just comma — so a bulk-import
// CSV cell (shiftImport.js's `template` row type) can list several days
// without needing to quote the field just because CSV itself delimits on
// commas (e.g. "1 2 3 4 5" or "5|6" work exactly like "1,2,3,4,5"). The
// admin UI's checkbox array and PATCH's existing comma-joined string both
// still parse identically — this is a strict superset of the old behavior.
export function parseDaysOfWeek(value) {
  // .filter(Boolean) matters: without it, splitting '' yields [''], and
  // Number('') is 0 — a blank/missing value would silently resolve to
  // "Sunday" instead of "no days" (the .length check below exists
  // specifically to reject the latter).
  const days = Array.isArray(value) ? value : String(value || '').split(/[,\s|]+/).filter(Boolean);
  const nums = days.map((d) => Number(d)).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6);
  const unique = [...new Set(nums)].sort((a, b) => a - b);
  return unique.length ? unique.join(',') : null;
}

export function parseStaffCount(value) {
  if (value === null || value === undefined || value === '') return { ok: true, value: null };
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) return { ok: false };
  return { ok: true, value: n };
}
