// Renders the agent guide as a single Markdown document — meant to be
// pasted into an agent's (Hermes's) own system prompt or knowledge base, or
// fetched live at GET /api/agent-guide/markdown so it can never drift from
// what the API actually does. AGENT-TRAINING.md at the repo root is a
// courtesy, manually-refreshed snapshot of this same output for offline
// reading — prefer fetching it live from the specific deployment an agent
// is actually talking to (this app has two: see CLAUDE.md §2).
export function renderAgentGuideMarkdown(guide, { appName = '&Shawarma Scheduling', baseUrl = '' } = {}) {
  const lines = [];
  const p = (s = '') => lines.push(s);

  p(`# ${appName} — Agent Integration Guide`);
  p();
  p(`This document tells an AI agent (or any other system authenticating with an API key) how to safely read and write schedule data in this app. It is generated from the app's own action registry (\`src/lib/agentGuide/registry.js\`), so it stays in sync with what the API actually does — fetch it live at \`GET /api/agent-guide/markdown\` rather than keeping a stale copy. See \`CLAUDE.md\` in the app repository for the full schema, business rules, and deployment context this guide assumes.`);
  p();

  p('## Ground rules');
  p();
  for (const principle of guide.principles) {
    p(`**${principle.title}.** ${principle.body}`);
    p();
  }

  p('## Authentication');
  p();
  p(`- Scheme: ${guide.authentication.scheme}`);
  p(`- Header: \`${guide.authentication.header}\``);
  p(`- Create a key: ${guide.authentication.create_at}`);
  p(`- ${guide.authentication.notes}`);
  p();

  p('## Actions');
  p();
  p('One entry per write (or read) action. Anything not listed here that nonetheless looks like an API route is not part of this contract — do not call undocumented endpoints.');
  p();
  for (const a of guide.direct_actions) {
    p(`### ${a.label}`);
    p();
    p(`\`${a.method} ${baseUrl}${a.url}\` — minimum role: **${a.minRole}** — ${a.agentMayCall ? 'agent may call this' : '**human-only step, documented for context — do not call automatically**'}`);
    p();
    p(a.purpose);
    p();
    if (a.idempotency) {
      p(`**Idempotency:** ${a.idempotency}`);
      p();
    }
    if (a.body && a.body.length) {
      p('**Request body:**');
      p();
      p('| field | type | required | notes |');
      p('|---|---|---|---|');
      for (const f of a.body) {
        p(`| \`${f.field}\` | ${f.type} | ${f.required ? 'yes' : 'no'} | ${f.notes || ''} |`);
      }
      p();
    }
    if (a.response) {
      p(`**Response:** ${a.response}`);
      p();
    }
  }

  const bi = guide.bulk_import;
  p('## Bulk schedule import');
  p();
  p(`For loading a whole schedule at once (a spreadsheet, a photo of a handwritten schedule, a pasted message spanning many shifts) instead of one-row-at-a-time direct-action calls. One batch can mix all four row types below.`);
  p();
  p(`- Call with an API key: \`${bi.endpoint_api_key}\``);
  p(`- Or with an admin/manager session (the Manage UI's own path): \`${bi.endpoint_session}\``);
  p(`- Content-Type: ${bi.content_types.join(' or ')}`);
  p(`- Get the current roster (for name matching) first: \`${bi.template_url}\``);
  p(`- Max ${bi.max_rows} rows per batch. ${bi.all_or_nothing ? 'All-or-nothing: if any row fails validation, nothing is written and every error is returned so the whole batch can be fixed and resubmitted.' : ''}`);
  p();
  p('| type | columns | notes |');
  p('|---|---|---|');
  for (const rt of bi.row_types) {
    p(`| \`${rt.type}\` | ${rt.columns.join(', ')} | ${rt.description} |`);
  }
  p();
  p('Name matching (the `username` column on `shift`/`swap` rows) is fuzzy on purpose: it accepts the exact system username, a full display name, or a first name — a first name shared by two people is treated as ambiguous and errors rather than guessing.');
  p();

  return lines.join('\n');
}
