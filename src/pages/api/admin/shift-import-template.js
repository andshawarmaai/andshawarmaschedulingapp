// Generates the downloadable CSV template fresh on every request — it
// always reflects the current roster (a comment block lists every valid
// username) so it never goes stale, and there's nothing to keep in sync
// with a static file.
import db from '../../../lib/db/index.js';
import { buildTemplateCsv } from '../../../lib/shiftImport.js';

export const prerender = false;

export async function GET() {
  const users = await db.listUsers();
  const csv = buildTemplateCsv(users);
  return new Response(csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="shift-import-template.csv"',
    },
  });
}
