// Revoke an admin's own Telegram bot. Deliberately scoped to the caller's
// own bots — one admin can never revoke another admin's bot from here.
import db from '../../../../lib/db/index.js';
import { deleteWebhook } from '../../../../lib/telegram.js';

export const prerender = false;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

export async function DELETE(context) {
  const me = context.locals.user;
  const { id } = context.params;

  const bot = await db.getTelegramBotById(id);
  if (!bot || bot.user_id !== me.id) {
    return json({ error: 'Bot not found.' }, 404);
  }

  try {
    await deleteWebhook(bot.bot_token);
  } catch {
    // Telegram-side cleanup is best-effort — revoking locally still fully
    // disables it, since the webhook receiver checks `revoked` too.
  }
  await db.revokeTelegramBot(id);
  return json({ ok: true });
}
