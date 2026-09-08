// Receives updates from one specific admin's Telegram bot. There's no
// session cookie here — Telegram is the caller — so this route is exempted
// in middleware.js and verifies the request itself via the secret token
// Telegram echoes back in a header (set at registration time, see
// api/admin/telegram-bots/index.js).
//
// Slash commands (/shift, /cap, /swap) are always understood, deterministically
// — they map 1:1 onto the same row shape the CSV bulk import already
// validates. Any other text is handed to whichever LLM is configured (see
// ../../../../lib/llm/index.js — swappable per-provider, off entirely if
// neither LLM_PROVIDER nor its API key is set) purely to EXTRACT rows in
// that same shape; the LLM never resolves names or writes anything itself,
// so a hallucinated name or bad date is rejected by the exact same
// validation a bad command or spreadsheet row would hit.
import db from '../../../../lib/db/index.js';
import { sendMessage } from '../../../../lib/telegram.js';
import { runShiftImport } from '../../../../lib/shiftImport.js';
import { isLlmConfigured, interpretScheduleMessage } from '../../../../lib/llm/index.js';

export const prerender = false;

const HELP_TEXT = [
  "Here's what I understand:",
  '/shift <name> <date> <start> <end> [notes] — e.g. /shift Adnan 2026-09-15 11:00 19:00',
  '/cap <date> <start> <end> <max> [notes] — e.g. /cap 2026-09-15 11:00 15:00 2 lunch rush',
  '/swap <name> <date> <start> [reason] — puts an existing shift up for swap',
  'Dates are YYYY-MM-DD, times are 24h HH:MM.',
].join('\n');

function parseCommand(text) {
  const parts = text.trim().split(/\s+/);
  const cmd = (parts.shift() || '').replace(/^\//, '').toLowerCase();
  if (cmd === 'shift') {
    const [username, date, start_time, end_time, ...rest] = parts;
    return { type: 'shift', username, date, start_time, end_time, notes: rest.join(' ') };
  }
  if (cmd === 'cap') {
    const [date, window_start, window_end, max_shifts, ...rest] = parts;
    return { type: 'cap', date, window_start, window_end, max_shifts, notes: rest.join(' ') };
  }
  if (cmd === 'swap') {
    const [username, date, start_time, ...rest] = parts;
    return { type: 'swap', username, date, start_time, notes: rest.join(' ') };
  }
  return null;
}

export async function POST(context) {
  const { id } = context.params;
  const bot = await db.getTelegramBotById(id);
  if (!bot || bot.revoked) {
    return new Response('not found', { status: 404 });
  }

  const secretHeader = context.request.headers.get('x-telegram-bot-api-secret-token');
  if (secretHeader !== bot.webhook_secret) {
    return new Response('forbidden', { status: 403 });
  }

  const update = await context.request.json().catch(() => null);
  const message = update && update.message;
  const text = message && typeof message.text === 'string' ? message.text.trim() : '';
  const chatId = message && message.chat && message.chat.id;

  // Always 200 back to Telegram immediately after this point regardless of
  // what happens below — a non-2xx makes Telegram retry the same update.
  if (!message || !chatId) return new Response('ok');

  const reply = (msg) => sendMessage(bot.bot_token, chatId, msg).catch(() => {});

  if (text === '/start') {
    if (bot.chat_id && bot.chat_id !== String(chatId)) {
      await reply('This bot is already linked to someone else.');
      return new Response('ok');
    }
    await db.linkTelegramBotChat(bot.id, chatId);
    await reply(`Linked! I'll make schedule changes as you.\n\n${HELP_TEXT}`);
    return new Response('ok');
  }

  if (!bot.chat_id || bot.chat_id !== String(chatId)) {
    await reply('This bot is not linked to you. Send /start first.');
    return new Response('ok');
  }

  if (text === '/help' || text === 'help') {
    await reply(HELP_TEXT);
    return new Response('ok');
  }

  let rows;
  if (text.startsWith('/')) {
    const parsed = parseCommand(text);
    if (!parsed) {
      await reply(`Sorry, I didn't understand that.\n\n${HELP_TEXT}`);
      return new Response('ok');
    }
    rows = [parsed];
  } else if (isLlmConfigured()) {
    try {
      const users = await db.listUsers();
      const today = new Date().toISOString().slice(0, 10);
      const { rows: llmRows, clarification } = await interpretScheduleMessage(text, { users, today });
      if (llmRows.length === 0) {
        await reply(clarification || `I couldn't pull a schedule change out of that.\n\n${HELP_TEXT}`);
        return new Response('ok');
      }
      rows = llmRows;
    } catch (err) {
      await reply(`Couldn't reach the language model: ${err.message}`);
      return new Response('ok');
    }
  } else {
    await reply(`Sorry, I only understand commands right now.\n\n${HELP_TEXT}`);
    return new Response('ok');
  }

  const result = await runShiftImport(db, {
    rows,
    filename: `telegram:@${bot.bot_username || bot.id}`,
    uploaded_by: bot.user_id,
  });
  await db.touchTelegramBot(bot.id);

  if (result.error) {
    const detail = result.rowErrors ? result.rowErrors.join('\n') : result.error;
    await reply(`Couldn't do that:\n${detail}`);
  } else {
    const b = result.breakdown;
    const parts = [];
    if (b.shifts) parts.push(`${b.shifts} shift${b.shifts === 1 ? '' : 's'}`);
    if (b.caps) parts.push(`${b.caps} cap${b.caps === 1 ? '' : 's'}`);
    if (b.swaps) parts.push(`${b.swaps} swap${b.swaps === 1 ? '' : 's'}`);
    await reply(`Done — ${parts.join(', ')} saved.`);
  }

  return new Response('ok');
}
