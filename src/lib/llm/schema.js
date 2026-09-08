// Shared between every LLM backend (see index.js) so swapping providers
// never means re-writing the extraction contract. The LLM's only job is to
// turn a spoken/typed message into rows shaped exactly like a CSV import
// row — it never resolves names or validates anything itself. That still
// happens in shiftImport.js's validateImportRows, same as a CSV upload, so
// a hallucinated name or a bad date gets rejected the same way a bad
// spreadsheet row would, not written on the LLM's say-so.

export function buildSystemPrompt({ users, today }) {
  const roster = users
    .filter((u) => !u.disabled)
    .map((u) => `${u.display_name} (username: ${u.username})`)
    .join(', ');
  return [
    `You extract restaurant schedule changes from a message an admin sent to a Telegram bot. Today's date is ${today} (YYYY-MM-DD) — resolve relative dates ("tomorrow", "Friday", "next Tuesday") against it.`,
    `Staff roster, for spelling reference only (do not decide who matches — just write the name as the admin said it): ${roster}`,
    'A message can contain more than one request (e.g. "give Jorge Tuesday 11 to 7, cap Friday lunch at 2 people, and put my Saturday shift up for swap" is three rows).',
    'Row types: "shift" (assign someone a shift: username, date, start_time, end_time, notes), "cap" (limit how many can work a window: date, window_start, window_end, max_shifts, notes), "swap" (post an EXISTING shift for swap: username, date, start_time, notes=reason).',
    'Times are 24h HH:MM, dates are YYYY-MM-DD. If the message is too vague to extract anything with confidence, return an empty rows array and explain what you need clarified instead of guessing.',
  ].join('\n');
}

export const TOOL_NAME = 'submit_schedule_rows';
export const TOOL_DESCRIPTION = 'Submit the schedule change(s) extracted from the admin\'s message.';

// Draft-7-ish JSON Schema for the tool's input — shared verbatim between
// Anthropic's `input_schema` and OpenAI's `parameters`.
export const TOOL_PARAMETERS = {
  type: 'object',
  properties: {
    rows: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['shift', 'cap', 'swap'] },
          username: { type: 'string', description: 'Name as the admin said it (shift/swap only).' },
          date: { type: 'string', description: 'YYYY-MM-DD' },
          start_time: { type: 'string', description: 'HH:MM 24h (shift/swap)' },
          end_time: { type: 'string', description: 'HH:MM 24h (shift only)' },
          window_start: { type: 'string', description: 'HH:MM 24h (cap only)' },
          window_end: { type: 'string', description: 'HH:MM 24h (cap only)' },
          max_shifts: { type: 'integer', description: 'cap only' },
          notes: { type: 'string' },
        },
        required: ['type'],
      },
    },
    clarification_needed: {
      type: 'string',
      description: 'Set this instead of guessing when the message is too ambiguous to extract confidently.',
    },
  },
  required: ['rows'],
};

// Normalizes a provider's raw tool-call arguments into the row shape
// runShiftImport/validateImportRows expect (same field names parseCsv
// produces from a header row).
export function normalizeRows(parsed) {
  if (!parsed || !Array.isArray(parsed.rows)) return { rows: [], clarification: parsed && parsed.clarification_needed };
  const rows = parsed.rows.map((r) => ({
    type: String(r.type || '').trim().toLowerCase(),
    username: r.username != null ? String(r.username) : '',
    date: r.date != null ? String(r.date) : '',
    start_time: r.start_time != null ? String(r.start_time) : '',
    end_time: r.end_time != null ? String(r.end_time) : '',
    window_start: r.window_start != null ? String(r.window_start) : '',
    window_end: r.window_end != null ? String(r.window_end) : '',
    max_shifts: r.max_shifts != null ? String(r.max_shifts) : '',
    notes: r.notes != null ? String(r.notes) : '',
  }));
  return { rows, clarification: parsed.clarification_needed || null };
}
