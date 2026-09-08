// Bulk CSV shift import via the Manage UI. Gated to admin/manager by
// middleware.js (ADMIN_ONLY_PREFIXES covers /api/admin). See also
// api/public/shift-imports.js for the API-key-authenticated equivalent an
// external agent can call directly.
import db from '../../../../lib/db/index.js';
import { runShiftImport } from '../../../../lib/shiftImport.js';

export const prerender = false;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

export async function POST(context) {
  const me = context.locals.user;
  const body = await context.request.json().catch(() => null);
  if (!body || !Array.isArray(body.rows)) {
    return json({ error: 'No rows to import.' }, 400);
  }

  const result = await runShiftImport(db, { rows: body.rows, filename: body.filename, uploaded_by: me.id });
  if (result.error) return json(result, 400);
  return json(result, 201);
}
