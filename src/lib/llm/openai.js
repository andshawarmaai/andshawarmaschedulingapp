import { buildSystemPrompt, TOOL_NAME, TOOL_DESCRIPTION, TOOL_PARAMETERS, normalizeRows } from './schema.js';

const DEFAULT_MODEL = 'gpt-4o-mini';

export async function interpretScheduleMessage(text, { users, today }) {
  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.LLM_MODEL || DEFAULT_MODEL;

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: buildSystemPrompt({ users, today }) },
        { role: 'user', content: text },
      ],
      tools: [{ type: 'function', function: { name: TOOL_NAME, description: TOOL_DESCRIPTION, parameters: TOOL_PARAMETERS } }],
      tool_choice: { type: 'function', function: { name: TOOL_NAME } },
    }),
  });

  const data = await res.json().catch(() => null);
  if (!res.ok || !data) {
    throw new Error((data && data.error && data.error.message) || `OpenAI API error (HTTP ${res.status})`);
  }
  const call = data.choices?.[0]?.message?.tool_calls?.[0];
  if (!call) throw new Error('Model did not return structured rows.');
  let parsed;
  try {
    parsed = JSON.parse(call.function.arguments);
  } catch {
    throw new Error('Model returned malformed JSON.');
  }
  return normalizeRows(parsed);
}
