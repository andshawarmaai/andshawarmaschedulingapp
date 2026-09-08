// Picks which LLM interprets natural-language Telegram messages, the same
// way db/index.js picks a storage backend — set LLM_PROVIDER to "anthropic"
// or "openai" plus that provider's API key, and nothing else in the app
// needs to change. With neither configured, the bot only understands the
// deterministic /shift, /cap, /swap commands (see the webhook handler).

export function isLlmConfigured() {
  const provider = (process.env.LLM_PROVIDER || '').toLowerCase();
  if (provider === 'anthropic') return !!process.env.ANTHROPIC_API_KEY;
  if (provider === 'openai') return !!process.env.OPENAI_API_KEY;
  return false;
}

// Returns { rows, clarification }. Throws on a network/API failure — the
// caller (the Telegram webhook) turns that into a friendly chat reply
// rather than a crash.
export async function interpretScheduleMessage(text, context) {
  const provider = (process.env.LLM_PROVIDER || '').toLowerCase();
  if (provider === 'anthropic') {
    const { interpretScheduleMessage: run } = await import('./anthropic.js');
    return run(text, context);
  }
  if (provider === 'openai') {
    const { interpretScheduleMessage: run } = await import('./openai.js');
    return run(text, context);
  }
  throw new Error('No LLM provider configured (set LLM_PROVIDER + its API key).');
}
