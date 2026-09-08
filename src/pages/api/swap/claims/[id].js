import db from '../../../../lib/db/index.js';

export const prerender = false;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function isStaffOrAbove(user) {
  return user.role === 'admin' || user.role === 'manager';
}

export async function PATCH(context) {
  if (!isStaffOrAbove(context.locals.user)) {
    return json({ error: 'Only admins and managers can approve or deny swaps.' }, 403);
  }
  const { id } = context.params;
  const body = await context.request.json().catch(() => null);
  if (!body || (body.status !== 'approved' && body.status !== 'denied')) {
    return json({ error: 'status must be "approved" or "denied".' }, 400);
  }

  if (body.status === 'denied') {
    const claim = await db.getSwapClaim(id);
    if (!claim) return json({ error: 'Claim not found.' }, 404);
    if (claim.status !== 'pending') return json({ error: `Already ${claim.status}.`, status: claim.status }, 409);
    const updated = await db.updateSwapClaim(id, { status: 'denied' });
    return json({ ok: true, claim: updated });
  }

  const result = await db.approveSwapClaimTx(id);
  if (result.error === 'not_found') return json({ error: 'Claim not found.' }, 404);
  if (result.error === 'already_resolved') return json({ error: `Already ${result.status}.`, status: result.status }, 409);
  if (result.error === 'post_closed') return json({ error: 'That post is no longer open.' }, 409);
  if (result.error) return json({ error: 'Could not approve this swap.' }, 500);
  return json({ ok: true });
}
