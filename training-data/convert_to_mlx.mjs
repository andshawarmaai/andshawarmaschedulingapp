#!/usr/bin/env node
// Converts the canonical dataset.jsonl (tool_calls as a plain array) into
// the chat-format JSONL mlx_lm.lora expects: one {"messages":[...]} object
// per line, with tool_calls rendered in the standard OpenAI function-calling
// shape so a Qwen2.5-family tokenizer's own chat template (which already
// knows how to emit <tool_call> blocks for that shape) can render it —
// see training-data/README.md "Converting" section for why this step is
// separate from generate.mjs and depends on the chosen base model.
//
// Usage: node training-data/convert_to_mlx.mjs [--in training-data/dataset.jsonl] [--outDir training-data/mlx] [--seed 2]

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1]]);
    return acc;
  }, [])
);
const IN = resolve(process.cwd(), args.in || 'training-data/dataset.jsonl');
const OUT_DIR = resolve(process.cwd(), args.outDir || 'training-data/mlx');
let SEED = Number(args.seed || 2);
function rand() {
  SEED |= 0; SEED = (SEED + 0x6D2B79F5) | 0;
  let t = Math.imul(SEED ^ (SEED >>> 15), 1 | SEED);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// ─── Tool schemas — mirrors scripts/mcp-server.mjs's 10 registered tools ───
// Kept in sync by hand; if a tool is added/changed there, update here too
// (and regenerate) before the next training run.
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'state_read',
      description: 'The single aggregate read - users, shifts, availability requests, time off, shift templates, day caps, swap posts/claims. Call this first to resolve names to ids and see what already exists before writing anything.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'shift_create',
      description: 'Creates a real, immediately-live scheduled shift (not a request needing approval). Use when a manager/admin has already decided who works when.',
      parameters: {
        type: 'object',
        properties: {
          user_id: { type: 'string', description: 'Resolve via state_read users. Omit for an unassigned shift.' },
          date: { type: 'string', description: 'YYYY-MM-DD' },
          start_time: { type: 'string', description: 'HH:MM 24h' },
          end_time: { type: 'string', description: 'HH:MM 24h. end_time <= start_time means the shift crosses midnight - do not "correct" it.' },
          department: { type: 'string', enum: ['FOH', 'BOH'] },
          notes: { type: 'string' },
        },
        required: ['date', 'start_time', 'end_time'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'shift_update',
      description: 'Move or edit an already-scheduled shift. Immediate - no separate approval step. Send only the fields being changed.',
      parameters: {
        type: 'object',
        properties: {
          shift_id: { type: 'string' },
          user_id: { type: 'string' },
          date: { type: 'string' },
          start_time: { type: 'string' },
          end_time: { type: 'string' },
          department: { type: 'string', enum: ['FOH', 'BOH'] },
          notes: { type: 'string' },
        },
        required: ['shift_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'shift_delete',
      description: 'Removes a shift from the schedule. Immediate, no undo. Only call on an unambiguous, specific instruction.',
      parameters: { type: 'object', properties: { shift_id: { type: 'string' } }, required: ['shift_id'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'availability_create',
      description: 'Submits a staff member\'s availability. Always submitted as the API key owner. Use start_time="00:00", end_time="23:59" for "available all day".',
      parameters: {
        type: 'object',
        properties: {
          date: { type: 'string' },
          start_time: { type: 'string' },
          end_time: { type: 'string' },
          notes: { type: 'string' },
        },
        required: ['date', 'start_time', 'end_time'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'availability_cancel',
      description: 'Cancels/withdraws a still-pending availability submission.',
      parameters: { type: 'object', properties: { shift_request_id: { type: 'string' } }, required: ['shift_request_id'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'timeoff_create',
      description: 'Submits a staff member\'s time-off request. Always submitted as the API key owner.',
      parameters: {
        type: 'object',
        properties: {
          start_date: { type: 'string' },
          end_date: { type: 'string' },
          reason: { type: 'string' },
        },
        required: ['start_date', 'end_date'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'timeoff_cancel',
      description: 'Cancels a time-off request, withdrawing it regardless of its current status.',
      parameters: { type: 'object', properties: { timeoff_id: { type: 'string' } }, required: ['timeoff_id'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'swap_post_create',
      description: 'Posts an existing shift for swap. A staff key can only post their own shift; a manager/admin key can post anyone\'s.',
      parameters: {
        type: 'object',
        properties: { shift_id: { type: 'string' }, reason: { type: 'string' } },
        required: ['shift_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'swap_claim_create',
      description: 'Volunteers for a posted shift. Blocked if the slot is already at a day-cap max, or the caller already has a pending claim on that post.',
      parameters: {
        type: 'object',
        properties: {
          post_id: { type: 'string' },
          offer_shift_id: { type: 'string', description: "One of the claimant's own shifts, offered back to the original poster." },
        },
        required: ['post_id'],
      },
    },
  },
];

function buildSystemContent(row) {
  const ctx = row.context;
  const userList = ctx.users.map((u) => `${u.username}=${u.display_name}`).join(', ');
  const templateList = ctx.templates.map((t) => `${t.name} ${t.start_time}-${t.end_time} days:${t.days_of_week.join('')}`).join(' | ');
  const contextLine = row.lang === 'es'
    ? `\n\nHoy: ${ctx.today}\nPersonal: ${userList}\nPlantillas de turnos: ${templateList}`
    : `\n\nToday: ${ctx.today}\nStaff: ${userList}\nShift templates: ${templateList}`;
  return row.system + contextLine;
}

function toolCallsToOpenAI(toolCalls, idBase) {
  return toolCalls.map((tc, i) => ({
    id: `call_${idBase}_${i}`,
    type: 'function',
    function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
  }));
}

function convertRow(row) {
  const messages = [{ role: 'system', content: buildSystemContent(row) }];
  row.messages.forEach((m, i) => {
    if (m.role === 'assistant') {
      const out = { role: 'assistant', content: m.content || '' };
      if (m.tool_calls && m.tool_calls.length) out.tool_calls = toolCallsToOpenAI(m.tool_calls, `${row.id}_${i}`);
      messages.push(out);
    } else {
      messages.push({ role: m.role, content: m.content });
    }
  });
  return { messages, tools: TOOLS };
}

const rows = readFileSync(IN, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

// Shuffle again (independent seed from generate.mjs) before splitting so
// train/valid/test each get a representative category/language mix rather
// than inheriting whatever block order the source file happened to have.
for (let i = rows.length - 1; i > 0; i--) {
  const j = Math.floor(rand() * (i + 1));
  [rows[i], rows[j]] = [rows[j], rows[i]];
}

const converted = rows.map(convertRow);
const nTotal = converted.length;
const nValid = Math.max(1, Math.round(nTotal * 0.05));
const nTest = Math.max(1, Math.round(nTotal * 0.05));
const valid = converted.slice(0, nValid);
const test = converted.slice(nValid, nValid + nTest);
const train = converted.slice(nValid + nTest);

mkdirSync(OUT_DIR, { recursive: true });
for (const [name, set] of [['train', train], ['valid', valid], ['test', test]]) {
  writeFileSync(resolve(OUT_DIR, `${name}.jsonl`), set.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

console.log(`Wrote ${train.length} train / ${valid.length} valid / ${test.length} test examples to ${OUT_DIR}`);
console.log(`(from ${nTotal} total canonical examples in ${IN})`);
