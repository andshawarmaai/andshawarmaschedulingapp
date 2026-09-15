// Machine-readable entry point for any agent (Hermes, or anything else)
// integrating with this app: one call returns every direct action it can
// take and the bulk-import contract, with request shapes, idempotency
// rules, and role requirements. See markdown.js for the human/system-
// prompt-friendly rendering of the same data. Deliberately exempted from
// auth in middleware.js — this is documentation (the same content as the
// committed AGENT-TRAINING.md), not restaurant data, and an agent should be
// able to read how to integrate before it necessarily has a key yet.
import { buildAgentGuide } from '../../../lib/agentGuide/build.js';

export const prerender = false;

export async function GET() {
  return new Response(JSON.stringify({ ok: true, guide: buildAgentGuide() }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
