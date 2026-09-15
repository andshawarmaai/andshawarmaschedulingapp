// Human/system-prompt-friendly rendering of the same guide index.js serves
// as JSON — paste this into an agent's own system prompt or knowledge base,
// or fetch it live rather than trusting a possibly-stale copy of
// AGENT-TRAINING.md. Same auth exemption as index.js (see its comment).
import { buildAgentGuide } from '../../../lib/agentGuide/build.js';
import { renderAgentGuideMarkdown } from '../../../lib/agentGuide/markdown.js';

export const prerender = false;

export async function GET(context) {
  const md = renderAgentGuideMarkdown(buildAgentGuide(), { baseUrl: context.url.origin });
  return new Response(md, {
    status: 200,
    headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
  });
}
