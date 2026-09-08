import { buildSystemPrompt, TOOL_NAME, TOOL_DESCRIPTION, TOOL_PARAMETERS, normalizeRows } from './schema.js';

const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';

export async function interpretScheduleMessage(text, { users, today }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const model = process.env.LLM_MODEL || DEFAULT_MODEL;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      system: buildSystemPrompt({ users, today }),
      messages: [{ role: 'user', content: text }],
      tools: [{ name: TOOL_NAME, description: TOOL_DESCRIPTION, input_schema: TOOL_PARAMETERS }],
      tool_choice: { type: 'tool', name: TOOL_NAME },
    }),
  });

  const data = await res.json().catch(() => null);
  if (!res.ok || !data) {
    throw new Error((data && data.error && data.error.message) || `Anthropic API error (HTTP ${res.status})`);
  }
  const toolUse = (data.content || []).find((b) => b.type === 'tool_use' && b.name === TOOL_NAME);
  if (!toolUse) throw new Error('Model did not return structured rows.');
  return normalizeRows(toolUse.input);
}
