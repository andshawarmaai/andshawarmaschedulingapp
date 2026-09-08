// Thin wrapper around Telegram's Bot API (https://core.telegram.org/bots/api).
// Each admin registers their own bot token (from @BotFather) — there's no
// shared bot, so revoking one admin's bot never touches anyone else's.

const API_ROOT = 'https://api.telegram.org/bot';

async function callTelegramApi(botToken, method, payload) {
  const res = await fetch(`${API_ROOT}${botToken}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {}),
  });
  const data = await res.json().catch(() => null);
  if (!data || !data.ok) {
    const desc = (data && data.description) || `HTTP ${res.status}`;
    throw new Error(`Telegram API ${method} failed: ${desc}`);
  }
  return data.result;
}

// Validates a token and returns the bot's own username (for display) —
// this is also the standard way to confirm a pasted token is real before
// storing it.
export async function getMe(botToken) {
  return callTelegramApi(botToken, 'getMe');
}

// Points Telegram at our webhook for this specific bot. secretToken is
// echoed back by Telegram on every call as the
// X-Telegram-Bot-Api-Secret-Token header, so the receiver can reject
// requests that didn't actually come from Telegram.
export async function setWebhook(botToken, webhookUrl, secretToken) {
  return callTelegramApi(botToken, 'setWebhook', {
    url: webhookUrl,
    secret_token: secretToken,
    allowed_updates: ['message'],
  });
}

export async function deleteWebhook(botToken) {
  return callTelegramApi(botToken, 'deleteWebhook');
}

export async function sendMessage(botToken, chatId, text) {
  return callTelegramApi(botToken, 'sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
  });
}
