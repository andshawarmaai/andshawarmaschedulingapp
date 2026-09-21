// Chat Bot settings — admin/manager-only. The admin picks a provider,
// pastes an API key, the orchestrator uses it on every chat message.
// Key is encrypted at rest (AES-256-GCM, see src/lib/settingsCrypto.js).
//
// GET: returns { provider: "anthropic"|"openai"|"minimax"|null, has_key: bool }
// POST: { provider, api_key, model? } → stores, tests the key, returns { ok, models?: [...] }
// DELETE: clears both provider and key
//
// The key never leaves the server in the GET response. The model picker
// (after a successful POST test) lists available models so the admin can
// pin which one to use.

import dbCore from '../../../../lib/db/index.js';
import { encryptSecret, decryptSecret } from '../../../../lib/settingsCrypto.js';

export const prerender = false;

const SETTINGS_KEY = 'ai_assistant';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function isStaffOrAbove(role) {
  return role === 'admin' || role === 'manager';
}

// Provider registry. Each provider knows its default base URL, how to
// build the test request, and how to format a chat completion request.
// Adding a new provider = one entry here.
const PROVIDERS = {
  anthropic: {
    label: 'Anthropic Claude',
    defaultModel: 'claude-sonnet-4-5',
    baseUrl: 'https://api.anthropic.com',
    test: async (apiKey) => {
      // No /v1/models — hit /v1/messages with max_tokens=1 instead.
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }),
      });
      if (!r.ok) {
        const t = await r.text().catch(() => '');
        throw new Error(`Anthropic ${r.status}: ${t.slice(0, 200)}`);
      }
    },
    chat: async (apiKey, { model, system, messages, max_tokens }) => {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ model, max_tokens: max_tokens || 2048, system, messages }),
      });
      if (!r.ok) throw new Error(`Anthropic ${r.status}: ${await r.text().catch(() => '')}`);
      const data = await r.json();
      return data.content?.[0]?.text || '';
    },
  },
  openai: {
    label: 'OpenAI',
    defaultModel: 'gpt-4o-mini',
    baseUrl: 'https://api.openai.com',
    test: async (apiKey) => {
      const r = await fetch('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${apiKey}` } });
      if (!r.ok) {
        // Fall back to a tiny chat completion probe — works with
        // scoped keys that have chat permission but not models-list.
        const r2 = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'gpt-4o-mini', max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }),
        });
        if (!r2.ok) {
          const t = await r.text().catch(() => '');
          throw new Error(`OpenAI ${r.status}: ${t.slice(0, 200)}`);
        }
        return ['gpt-4o-mini', 'gpt-4o', 'gpt-4-turbo', 'gpt-3.5-turbo'];
      }
      return (await r.json()).data.map((m) => m.id);
    },
    chat: async (apiKey, { model, system, messages, max_tokens }) => {
      const r = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model, max_tokens: max_tokens || 2048, messages: [{ role: 'system', content: system }, ...messages] }),
      });
      if (!r.ok) throw new Error(`OpenAI ${r.status}: ${await r.text().catch(() => '')}`);
      const data = await r.json();
      return data.choices?.[0]?.message?.content || '';
    },
  },
  minimax: {
    label: 'MiniMax',
    defaultModel: 'MiniMax-M2',
    baseUrl: 'https://api.MiniMax.chat/v1',
    test: async (apiKey) => {
      // MiniMax's /v1/models endpoint requires an account-level key (not
      // a subscription key). Fall back to a tiny chat completion test
      // which works with both kinds of keys — if the key is valid for
      // chat at all, we'll get a response back.
      const probeBody = JSON.stringify({
        model: 'MiniMax-M2',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'ping' }],
      });
      const r = await fetch('https://api.MiniMax.chat/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: probeBody,
      });
      if (!r.ok) {
        const t = await r.text().catch(() => '');
        throw new Error(`MiniMax ${r.status}: ${t.slice(0, 200)}`);
      }
      // Tiny success — return a small set of model IDs the user can pick from.
      const data = await r.json();
      const used = data?.model || 'MiniMax-M2';
      return ['MiniMax-M2', 'MiniMax-M3', 'claude-3-5-sonnet-20241022', 'gpt-4o-mini'].filter((m) => true);
    },
    chat: async (apiKey, { model, system, messages, max_tokens }) => {
      const r = await fetch('https://api.MiniMax.chat/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model, max_tokens: max_tokens || 2048, messages: [{ role: 'system', content: system }, ...messages] }),
      });
      if (!r.ok) throw new Error(`MiniMax ${r.status}: ${await r.text().catch(() => '')}`);
      const data = await r.json();
      return data.choices?.[0]?.message?.content || '';
    },
  },
};

// === Routes ===

export async function GET(context) {
  const me = context.locals.user;
  if (!isStaffOrAbove(me.role)) return json({ error: 'Forbidden' }, 403);
  const raw = await dbCore.getSetting(SETTINGS_KEY);
  if (!raw) {
    return json({ ok: true, provider: null, model: null, has_key: false, providers: Object.entries(PROVIDERS).map(([k, v]) => ({ id: k, label: v.label, defaultModel: v.defaultModel })) });
  }
  const value = JSON.parse(decryptSecret(raw));
  return json({
    ok: true,
    provider: value.provider,
    model: value.model,
    has_key: !!value.api_key,
    providers: Object.entries(PROVIDERS).map(([k, v]) => ({ id: k, label: v.label, defaultModel: v.defaultModel })),
  });
}

export async function POST(context) {
  const me = context.locals.user;
  if (!isStaffOrAbove(me.role)) return json({ error: 'Forbidden' }, 403);
  const body = await context.request.json().catch(() => null);
  if (!body || !body.provider || !body.api_key) {
    return json({ error: 'provider and api_key are required.' }, 400);
  }
  const provider = PROVIDERS[body.provider];
  if (!provider) return json({ error: `Unknown provider: ${body.provider}. Choose one of: ${Object.keys(PROVIDERS).join(', ')}` }, 400);

  // Test the key before storing — fail fast with a useful error.
  let models = null;
  try {
    const result = await provider.test(body.api_key);
    if (Array.isArray(result)) models = result;
  } catch (err) {
    return json({ error: `Key test failed: ${err.message}` }, 400);
  }
  const value = JSON.stringify({ provider: body.provider, model, api_key: body.api_key });
  const encrypted = encryptSecret(value);
  await dbCore.setSetting(SETTINGS_KEY, encrypted, me.id);

  return json({ ok: true, provider: body.provider, model, has_key: true, models });
}

export async function DELETE(context) {
  const me = context.locals.user;
  if (!isStaffOrAbove(me.role)) return json({ error: 'Forbidden' }, 403);
  await dbCore.deleteSetting(SETTINGS_KEY);
  return json({ ok: true });
}

// Helper used by the chat orchestrator: get the decrypted provider config,
// or null if not set up.
export async function getActiveProviderConfig() {
  const raw = await dbCore.getSetting(SETTINGS_KEY);
  if (!raw) return null;
  try {
    const value = JSON.parse(decryptSecret(raw));
    const provider = PROVIDERS[value.provider];
    if (!provider) return null;
    return { ...value, provider };
  } catch (_) {
    return null;
  }
}
