import db from '../../../../lib/db/index.js';
import { slotStatus } from '../../../../lib/client/format.js';

export const prerender = false;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

export async function POST(context) {
  const me = context.locals.user;
  const body = await context.request.json().catch(() => null);
  if (!body || !body.post_id) return json({ error: 'post_id is required.' }, 400);

  const post = await db.getSwapPost(body.post_id);
  if (!post) return json({ error: 'Post not found.' }, 404);
  if (post.status !== 'open') return json({ error: 'This shift is no longer available.' }, 409);
  if (post.user_id === me.id) return json({ error: 'You cannot claim your own posted shift.' }, 400);

  // Slot caps block the staff self-service swap path. Admins/managers can
  // still schedule past a cap directly from the schedule editor — this only
  // stops someone volunteering their way into an already-full slot.
  const shift = await db.getShiftById(post.shift_id);
  if (shift) {
    const [dayCaps, shifts] = await Promise.all([db.listDayCaps(), db.listShifts()]);
    const status = slotStatus(dayCaps, shifts, shift.date, shift.start_time);
    if (status && status.full) {
      return json({ error: `This time slot is full (${status.count}/${status.cap.max_shifts}).`, cap: status.cap }, 409);
    }
  }

  if (body.offer_shift_id) {
    const offer = await db.getShiftById(body.offer_shift_id);
    if (!offer || offer.user_id !== me.id) {
      return json({ error: 'That is not one of your shifts.' }, 400);
    }
  }

  const existing = (await db.listSwapClaims()).find(
    (c) => c.post_id === post.id && c.claimant_id === me.id && c.status === 'pending'
  );
  if (existing) return json({ error: 'You already volunteered for this shift.' }, 409);

  const claim = await db.createSwapClaim({
    post_id: post.id,
    claimant_id: me.id,
    offer_shift_id: body.offer_shift_id || null,
  });
  return json({ ok: true, claim }, 201);
}
