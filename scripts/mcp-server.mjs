#!/usr/bin/env node
// &Shawarma scheduling app — MCP server for Hermes (or any MCP-compatible
// agent) to call this app's own API as REAL, structured tools instead of
// being asked to write a JSON block inside a plain-text reply.
//
// Why this exists: the previous design (see scripts/hermes-bridge.mjs and
// CHAT_BOT_PROMPT there) asked the model to emit a fenced ```json``` block
// that the bridge then regex-parsed out of free text. That block was
// skipped by the model roughly half the time in testing (see
// CHAT_BOT_DEBUG_HANDOFF.md / CHAT_BOT_HANDOFF_V2.md), because nothing
// forced it to be there — it was just a prompted convention. MCP tools are
// not a convention: the model calls them the same structured way it calls
// its own built-in tools (bash, file edit, etc.), validated against the
// schema below before this process ever sees the arguments.
//
// Run locally on the same Mac as the Hermes bridge (stdio transport — no
// separate port, no separate tunnel, Hermes spawns this as a child
// process). Register once:
//
//   hermes mcp add shawarma --command "node /Users/testuser/andshawarma-scheduling/scripts/mcp-server.mjs"
//
// then enable it per chat call with `--toolsets mcp-shawarma` (or whatever
// name `hermes mcp add` actually assigns — confirm with `hermes mcp list`
// after adding, since the exact toolset naming convention wasn't
// independently verifiable from outside the installed CLI).
//
// Auth: uses the SAME API key the bridge already uses (AGENT_API_KEY env
// var) — every call here is attributed to whichever real person created
// that key, exactly as if they'd clicked it in the app themselves (see
// CLAUDE.md §6 on API-key auth). Never hardcode a key here; the bridge's
// own hardcoded fallback key is a known issue already flagged in
// CLAUDE.md §11 and should be fixed the same way this file expects to be
// run (env var only).
//
// Tool set: deliberately covers the actions the chat bot's own system
// prompt says it's for — scheduling only (see SYSTEM_PROMPT in
// src/pages/api/agent/chat/index.js and PERSONALITY.hard_rules in
// src/lib/agentGuide/registry.js) — not the full registry (jobs,
// proficiency, POS imports, schedule-generation). Add more by copying the
// pattern below and pointing at the matching entry in registry.js, which
// stays the single source of truth for the shape/semantics of each route.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const VERCEL_BASE = process.env.VERCEL_BASE || 'https://andshawarmaschedulingapp.vercel.app';

// AGENT_API_KEY fallback chain:
//   1. process.env.AGENT_API_KEY (preferred — same key the bridge uses,
//      passed by whichever process spawns this one)
//   2. /Users/testuser/andshawarma-scheduling/.env.local (read directly so
//      the MCP server is self-contained — no env-injection drama with
//      `hermes mcp add --env`, which serializes the flag into `args:` not
//      `env:` in v0.21.3+, see CHAT_BOT_HANDOFF_V5/V6)
// Strips comments, ignores unrelated vars, returns the value or undefined.
function readEnvLocalValue(key) {
  const here = dirname(fileURLToPath(import.meta.url));
  const path = resolve(here, '..', '.env.local');
  if (!existsSync(path)) return undefined;
  const line = readFileSync(path, 'utf8')
    .split('\n')
    .find((l) => l.trim().startsWith(`${key}=`));
  if (!line) return undefined;
  const v = line.slice(line.indexOf('=') + 1).trim();
  return v && v !== '<redacted>' ? v : undefined;
}

const AGENT_API_KEY = process.env.AGENT_API_KEY || readEnvLocalValue('AGENT_API_KEY');

if (!AGENT_API_KEY) {
  console.error('AGENT_API_KEY is not set (neither in env nor in .env.local). Set it in the shell that launches this process, or add AGENT_API_KEY=shwrm_xxx to /Users/testuser/andshawarma-scheduling/.env.local');
  process.exit(1);
}

async function callApi(method, path, body) {
  // Logged to stderr (MCP's stdout is reserved for the protocol itself —
  // writing here would corrupt it) so a hang or failure is visible from
  // outside even though this process's own console isn't attached to a
  // terminal when Hermes spawns it. If a tool call never even logs the
  // "-> " line below, Hermes isn't reaching this server at all; if it
  // logs "->" but never "<-", the hang is in the fetch to VERCEL_BASE.
  console.error(`[${new Date().toISOString()}] -> ${method} ${path}`);
  const r = await fetch(`${VERCEL_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${AGENT_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: method === 'GET' ? undefined : JSON.stringify(body || {}),
  });
  console.error(`[${new Date().toISOString()}] <- ${method} ${path} : ${r.status}`);
  let data;
  try { data = await r.json(); } catch { data = await r.text().catch(() => ''); }
  if (!r.ok) {
    // Returned as a tool result (isError), not thrown — lets the model see
    // the real error and decide what to do (ask a clarifying question,
    // try a different value, or tell the user honestly), the same as any
    // other tool failure it already knows how to handle.
    return { content: [{ type: 'text', text: JSON.stringify({ error: true, status: r.status, body: data }) }], isError: true };
  }
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

const server = new McpServer({ name: 'shawarma-scheduling', version: '1.0.0' });

server.registerTool(
  'state_read',
  {
    title: 'Read current schedule state',
    description: "The single aggregate read - users, shifts, availability requests, time off, shift templates, day caps, swap posts/claims. Call this first to resolve names to ids and see what already exists before writing anything.",
    inputSchema: {},
  },
  async () => callApi('GET', '/api/state'),
);

server.registerTool(
  'shift_create',
  {
    title: 'Add a shift directly to the schedule',
    description: 'Creates a real, immediately-live scheduled shift (not a request needing approval). Use when a manager/admin has already decided who works when.',
    inputSchema: {
      user_id: z.string().optional().describe('Resolve via state_read users. Omit for an unassigned shift.'),
      date: z.string().describe('YYYY-MM-DD'),
      start_time: z.string().describe('HH:MM 24h'),
      end_time: z.string().describe('HH:MM 24h. end_time <= start_time means the shift crosses midnight - do not "correct" it.'),
      department: z.enum(['FOH', 'BOH']).nullable().optional(),
      notes: z.string().optional(),
    },
  },
  async (args) => callApi('POST', '/api/shifts', args),
);

server.registerTool(
  'shift_update',
  {
    title: 'Move or edit an already-scheduled shift',
    description: 'Immediate - no separate approval step. Send only the fields being changed.',
    inputSchema: {
      shift_id: z.string(),
      user_id: z.string().nullable().optional(),
      date: z.string().optional(),
      start_time: z.string().optional(),
      end_time: z.string().optional(),
      department: z.enum(['FOH', 'BOH']).nullable().optional(),
      notes: z.string().optional(),
    },
  },
  async ({ shift_id, ...rest }) => callApi('PATCH', `/api/shifts/${shift_id}`, rest),
);

server.registerTool(
  'shift_delete',
  {
    title: 'Remove a shift from the schedule',
    description: 'Immediate, no undo. Only call on an unambiguous, specific instruction.',
    inputSchema: { shift_id: z.string() },
  },
  async ({ shift_id }) => callApi('DELETE', `/api/shifts/${shift_id}`),
);

server.registerTool(
  'availability_create',
  {
    title: "Submit a staff member's availability",
    description: 'Always submitted as the API key owner. Use start_time="00:00", end_time="23:59" for "available all day".',
    inputSchema: {
      date: z.string(),
      start_time: z.string(),
      end_time: z.string(),
      notes: z.string().optional(),
    },
  },
  async (args) => callApi('POST', '/api/shift-requests', { action: 'create', ...args }),
);

server.registerTool(
  'availability_cancel',
  {
    title: 'Cancel a pending availability entry',
    description: 'Withdraws a still-pending availability submission.',
    inputSchema: { shift_request_id: z.string() },
  },
  async ({ shift_request_id }) => callApi('DELETE', `/api/shift-requests/${shift_request_id}`),
);

server.registerTool(
  'timeoff_create',
  {
    title: "Submit a staff member's time-off request",
    description: 'Always submitted as the API key owner.',
    inputSchema: {
      start_date: z.string(),
      end_date: z.string(),
      reason: z.string().optional(),
    },
  },
  async (args) => callApi('POST', '/api/timeoff', args),
);

server.registerTool(
  'timeoff_cancel',
  {
    title: 'Cancel a time-off request',
    description: 'Withdraws a request regardless of its current status.',
    inputSchema: { timeoff_id: z.string() },
  },
  async ({ timeoff_id }) => callApi('DELETE', `/api/timeoff/${timeoff_id}`),
);

server.registerTool(
  'swap_post_create',
  {
    title: 'Post a shift for swap',
    description: 'A staff key can only post their own shift; a manager/admin key can post anyone\'s.',
    inputSchema: {
      shift_id: z.string(),
      reason: z.string().optional(),
    },
  },
  async (args) => callApi('POST', '/api/swap/posts', args),
);

server.registerTool(
  'swap_claim_create',
  {
    title: 'Volunteer for a posted shift',
    description: 'Blocked if the slot is already at a day-cap max, or the caller already has a pending claim on that post.',
    inputSchema: {
      post_id: z.string(),
      offer_shift_id: z.string().optional().describe("One of the claimant's own shifts, offered back to the original poster."),
    },
  },
  async (args) => callApi('POST', '/api/swap/claims', args),
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('shawarma-scheduling MCP server ready (stdio)');
