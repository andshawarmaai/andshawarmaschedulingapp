// Register an admin's own Telegram bot. Gated to admin/manager by
// middleware.js (ADMIN_ONLY_PREFIXES covers /api/admin) but Telegram bots
// are admin-only per product decision, so we narrow further here.
//
// Flow: the admin pastes a bot token from @BotFather (create one by
// messaging @BotFather -> /newbot). We validate it with Telegram's own
// getMe, generate a private webhook secret, point Telegram's webhook at
// this deployment, and store everything. The admin then opens their new
// bot in Telegram and sends /start once, which links it to their account
// (see api/telegram/webhook/[id].js) — until that happens the bot can't
// act on anything, since we don't yet know which chat is theirs.
import crypto from 'node:crypto';
import db from '../../../../lib/db/index.js';
import { getMe, setWebhook } from '../../../../lib/telegram.js';

export const prerender = false;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

export async function POST(context) {
  const me = context.locals.user;
  if (me.role !== 'admin') {
    return json({ error: 'Only admins can connect a Telegram bot.' }, 403);
  }

  const body = await context.request.json().catch(() => null);
  const botToken = (body && body.bot_token ? String(body.bot_token) : '').trim();
  if (!botToken) {
    return json({ error: 'Paste your bot token from @BotFather (message it /newbot to get one).' }, 400);
  }

  let botInfo;
  try {
    botInfo = await getMe(botToken);
  } catch (err) {
    return json({ error: `Telegram rejected that token: ${err.message}` }, 400);
  }

  const webhookSecret = crypto.randomBytes(24).toString('base64url');
  const bot = await db.createTelegramBot({
    user_id: me.id,
    bot_token: botToken,
    bot_username: botInfo.username || null,
    webhook_secret: webhookSecret,
  });

  const webhookUrl = `${context.url.origin}/api/telegram/webhook/${bot.id}`;
  try {
    await setWebhook(botToken, webhookUrl, webhookSecret);
  } catch (err) {
    await db.revokeTelegramBot(bot.id);
    return json({ error: `Bot token is valid, but Telegram couldn't set up the connection: ${err.message}` }, 502);
  }

  return json({
    ok: true,
    bot: { id: bot.id, bot_username: bot.bot_username, linked: false, created_at: bot.created_at },
    message: `Connected @${botInfo.username}. Open it in Telegram and send /start to finish linking it to your account.`,
  }, 201);
}
