// Assembles the single object both the JSON endpoint and the Markdown
// endpoint render from — one source of truth so the two formats can't say
// different things about the same API.
import { PRINCIPLES, DIRECT_ACTIONS, PERSONALITY, PERSONALITY_PREAMBLE } from './registry.js';

// The bulk-import row types src/lib/shiftImport.js accepts — kept here
// (not re-derived from shiftImport.js's internals) since its TYPES set and
// validation logic aren't shaped as a declarative schema the way
// DIRECT_ACTIONS is. Keep this in sync with shiftImport.js's own header
// comment and buildTemplateCsv() if either changes.
const BULK_IMPORT_ROW_TYPES = [
  {
    type: 'shift',
    columns: ['username', 'date', 'start_time', 'end_time', 'notes'],
    description: 'Creates an actual, immediately-live scheduled shift (not a pending availability entry). No idempotency key — resubmitting the same batch creates duplicate shifts.',
  },
  {
    type: 'cap',
    columns: ['date', 'window_start', 'window_end', 'max_shifts', 'notes'],
    description: 'A one-off exception on a single date/window (separate from a recurring shift_template). Upserted by (date, window_start, window_end) — safe to resubmit.',
  },
  {
    type: 'swap',
    columns: ['username', 'date', 'start_time', 'notes (= swap reason)'],
    description: 'Posts an EXISTING shift (matched by username+date+start_time) for swap — errors if no such shift exists yet. No idempotency key — resubmitting posts it again.',
  },
  {
    type: 'template',
    columns: ['name', 'days_of_week', 'start_time', 'end_time', 'min_staff', 'max_staff'],
    description: 'Creates or updates a recurring weekly shift_template. days_of_week is 0(Sun)-6(Sat), separated by comma, space, or "|" (e.g. "1 2 3 4 5"). Matched and upserted by exact `name` — importing the same name again UPDATES it in place, safe to resubmit.',
  },
];

export function buildAgentGuide() {
  const personalityBlock = {
    audience: PERSONALITY.audience,
    role: PERSONALITY.role,
    voice: PERSONALITY.voice,
    hard_rules: PERSONALITY.hard_rules,
    fallbacks: PERSONALITY.fallbacks,
    preamble: PERSONALITY_PREAMBLE,
  };

  return {
    personality: personalityBlock,
    principles: PRINCIPLES,
    authentication: {
      scheme: 'API key',
      header: 'Authorization: Bearer shwrm_xxxxx',
      create_at: 'POST /api/admin/api-keys (admin session), or Manage → API Keys in the UI',
      notes: "A key acts as the exact user who created it, with that user's role — create it from an account with the role a given action requires. Resolved app-wide by middleware.js, so every route below (and any future one) works for an API-key caller with no per-route change needed.",
    },
    direct_actions: DIRECT_ACTIONS,
    bulk_import: {
      endpoint_api_key: 'POST /api/public/shift-imports  (Authorization: Bearer shwrm_xxxxx)',
      endpoint_session: 'POST /api/admin/shift-imports  (admin/manager session — used by the Manage UI)',
      content_types: ['text/csv (raw CSV body)', 'application/json  { filename?, rows: [...] }'],
      template_url: 'GET /api/admin/shift-import-template  (a live CSV with the current roster in a comment header)',
      max_rows: 1000,
      all_or_nothing: true,
      row_types: BULK_IMPORT_ROW_TYPES,
    },
  };
}
