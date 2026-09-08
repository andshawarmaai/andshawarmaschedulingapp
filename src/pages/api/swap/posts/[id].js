import db from '../../../../lib/db/index.js';

export const prerender = false;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

export async function DELETE(context) {
  const { id } = context.params;
  const me = context.locals.user;
  const post = await db.getSwapPost(id);
  if (!post) return json({ error: 'Post not found.' }, 404);
  if (post.user_id !== me.id && me.role !== 'admin' && me.role !== 'manager') {
    return json({ error: 'You can only cancel your own posts.' }, 403);
  }
  if (post.status !== 'open') {
    return json({ error: `This post is already ${post.status}.` }, 409);
  }
  await db.updateSwapPost(id, { status: 'cancelled' });
  return json({ ok: true });
}
