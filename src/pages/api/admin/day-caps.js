// Gated to admin/manager by middleware.js (ADMIN_ONLY_PREFIXES covers /api/admin).
import db from '../../../lib/db/index.js';

export const prerender = false;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

export async function POST(context) {
  const body = await context.request.json().catch(() => null);
  if (!body || !body.date || !body.window_start || !body.window_end || typeof body.max_shifts !== 'number') {
    return json({ error: 'date, window_start, window_end, and max_shifts are required.' }, 400);
  }
  if (body.window_start >= body.window_end) {
    return json({ error: 'window_start must be earlier than window_end.' }, 400);
  }
  if (body.max_shifts < 0) {
    return json({ error: 'max_shifts must be 0 or higher.' }, 400);
  }
  const cap = await db.upsertDayCap({
    date: body.date,
    window_start: body.window_start,
    window_end: body.window_end,
    max_shifts: body.max_shifts,
    note: body.note ? String(body.note).trim() : null,
  });
  return json({ ok: true, cap });
}

export async function DELETE(context) {
  const date = context.url.searchParams.get('date');
  const window_start = context.url.searchParams.get('window_start');
  const window_end = context.url.searchParams.get('window_end');
  if (!date || !window_start || !window_end) {
    return json({ error: 'date, window_start, and window_end query params are required.' }, 400);
  }
  await db.deleteDayCap({ date, window_start, window_end });
  return json({ ok: true });
}
