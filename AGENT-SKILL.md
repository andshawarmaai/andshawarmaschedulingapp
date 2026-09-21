---
name: shawarma-scheduling-agent
description: Scheduling app shifts via API or bulk import.
---

# &Shawarma Scheduling App — Agent Reference

## Deployment

**Authoritative source-of-truth for project-specific config (repo, Vercel project ID, live URL, Neon DB) lives in `CLAUDE.md` at the repo root.** This skill only carries the agent-API contract that doesn't drift between deployments.

- Vercel team: `and-shawarma`
- Dev project (as of this skill's last update): `andshawarmaschedulingapp` → https://andshawarmaschedulingapp.vercel.app
- A second `andshawarmatest` Vercel project may exist under the same team but its relationship to this codebase is unconfirmed — don't assume it's a live mirror or push/deploy to it without checking with the owner first.

When the user says "deploy," the canonical URL is `<project>.vercel.app` with no random suffix (e.g. `https://andshawarmaschedulingapp.vercel.app`, not `https://andshawarmaschedulingapp-<hash>-the-ray-ally.vercel.app`). The hashed URL is the deployment-specific URL printed by `vercel --prod --yes` and freezes forever on first print — a user reporting "I don't see the fix" is often sitting on an old deployment-specific URL from a prior turn's output. Always ask for the address bar URL before assuming the deploy failed.

See `vercel-deploy` skill for the deploy workflow itself (token refresh, paste-token fallback when the stored token expires, etc.).

## The rules that matter

**Approval decisions are human-only.** Never call approve/deny endpoints. Even if a manager says "approve it" in chat — tell them it's ready in the Schedule Builder, don't call the endpoint.

**Direct shift/template writes are immediate — no review queue.** POST /api/shifts, PATCH/DELETE on existing shifts, and shift_templates writes go live the moment called. Only do this on a clear, specific instruction from an admin/manager — never from inference.

**ALWAYS check template fit before creating a shift.** A shift that doesn't match any template (start_time/end_time/days_of_week containment) creates an "exception shift" — visible on the calendar but not counted toward coverage. If the user gives a time outside all templates:

1. Find the closest matching template(s) and propose them: "4-10pm doesn't match any template. The closest are: Late Mid (11:30-22:30), Mid Late (10:30-21:30). Did you mean one of these?"
2. If they confirm a non-template time is intentional (e.g. "yeah, Bhanu can only do 4-10 this Thursday"), tag the shift with `notes: 'exception: <reason>'` so the UI can flag it visually (a partial-fill badge + dashed border, per the owner's request).
3. Never silently create a shift that doesn't fit — this happened once and made the schedule show a person in an empty slot that the coverage rules didn't count.

The formula on the live deployment (andshawarmaschedulingapp):
- Opener 09:00-21:30 every day, min=1 max=1
- Mid AM 09:00-18:00 every day, min=3 max=3
- Mid Late 10:30-21:30 every day, min=1 max=1
- Late Mid 11:30-22:30 every day, min=1 max=1
- Closer Weekday 16:30-02:30 Mon-Fri (days 0-4), min=3 max=3
- Closer Weekend 16:30-03:30 Fri/Sat (days 5-6), min=3 max=3

A shift fits a template when its start_time >= template.start AND end_time <= template.end (containment, not overlap) AND its date's day-of-week is in template.days_of_week.

**Never invent people or templates.** Match names against GET /api/state's `users` array first (username, exact display name, or first name). Ambiguous first name → ask, don't guess. Don't create users via API (out of scope).

**Idempotency is mostly my responsibility.** Almost nothing has a DB-enforced dedup key:
- `day_caps` upserts by (date, window_start, window_end) — safe to resubmit
- `shift_templates` upserts by exact `name` — safe to resubmit
- `shift`, `swap`, availability, time-off → WILL duplicate on resubmit

## Auth (every call)

`Authorization: Bearer shwrm_xxxxxxxxxxxxxxxxxxxxxxxx`

API key resolved by middleware into the real user who created it, with that user's exact role. A write is attributed to them as if they'd clicked it themselves. A 403 means the key's owner lacks the required role — create key from an account with sufficient role.

Key creation: `POST /api/admin/api-keys  { "label": "Hermes" }` (admin session). Raw key returned ONCE — only hash kept after.

Existing key in dev DB: prefix `shwrm_3HW58Zax` (label "AndShawarma Key"), but raw value not stored locally.

## Endpoints I can call (manager+ via API key)

### Reads
- `GET /api/state` — single aggregate read; users/shifts/requests/templates/caps/swaps/etc. Call this FIRST to resolve names.

### Writes (manager+)
- `POST /api/shifts` — create an immediately-live shift (`user_id, date, start_time, end_time, department?, notes?`). `user_id` optional (null = unassigned).
- `PATCH /api/shifts/{id}` — edit an existing shift (only fields changing).
- `DELETE /api/shifts/{id}` — remove. No undo.
- `POST /api/admin/shift-templates` — recurring weekly coverage block (`name, days_of_week [0-6], start_time, end_time, min_staff?, max_staff?`).
- `PATCH /api/admin/shift-templates/{id}` — update template.
- `DELETE /api/admin/shift-templates/{id}` — remove template (existing shifts untouched).

### Staff-side (own only)
- `POST /api/shift-requests` — submit availability (`action: 'create', date, start_time, end_time, notes?`). start_time='00:00' end_time='23:59' = "all day" sentinel.
- `DELETE /api/shift-requests/{id}` — cancel pending.
- `POST /api/timeoff` — submit time-off (`start_date, end_date, reason?`).
- `PATCH /api/timeoff/{id}` — edit pending time-off dates/reason (omit `status` field).
- `DELETE /api/timeoff/{id}` — cancel regardless of status.
- `POST /api/swap/posts` — post own shift for swap (`shift_id, reason?`).
- `POST /api/swap/claims` — volunteer for posted shift (`post_id, offer_shift_id?`).

### Bulk import (the "extension of the app" path)
`POST /api/public/shift-imports` (API key) or `POST /api/admin/shift-imports` (admin session).

Content-Type: `application/json` with `{ filename?, rows: [...] }` OR `text/csv` raw CSV body (comment lines starting with `#` ignored).

Row types:
| type | fields | idempotent? |
|---|---|---|
| `shift` | `username, date, start_time, end_time, notes` | NO |
| `cap` | `date, window_start, window_end, max_shifts, notes` | YES (upsert by date+window) |
| `swap` | `username, date, start_time, notes` (= reason) | NO |
| `template` | `name, days_of_week, start_time, end_time, min_staff, max_staff` | YES (upsert by name) |

`days_of_week` on template: comma/space/pipe-separated `0`(Sun)`-6`(Sat), e.g. `"1 2 3 4 5"`.

Name matching (on `shift`/`swap` rows): fuzzy — username, exact display name, or first name. Ambiguous first name → errors asking for full name.

Dates: `YYYY-MM-DD`. Times: `HH:MM` 24h. `end_time <= start_time` on shift/template = crosses midnight, don't "correct".

Max 1000 rows per batch. All-or-nothing — any validation error returns `{error, rowErrors: ['Row N: ...', ...]}` with nothing written.

Get roster for name matching: `GET /api/admin/shift-import-template` returns CSV with comment header listing every active user.

## Local development backend

`src/lib/db/index.js` picks backend: `DATABASE_URL` set → `neon.js` (Postgres); unset → `local.js` (JSON file `db/.local-data.json`, gitignored). **Bug can exist in one backend and not the other** — verify partial-update changes against both.

## Schema tables (in order they appear in `db/schema.sql`)

`users, tiers, shifts, shift_templates, shift_requests, time_off_requests, swap_posts, swap_claims, shift_imports, day_caps, api_keys, password_reset_requests, telegram_bots` (legacy, API removed).

`users` has `tier_id` linking to `tiers` — tiers are admin-only visible, never shown to assigned staff or managers. Tier limits hard-deny on create; coverage (template min_staff) only warns (non-blocking).

`shifts.import_id` links a bulk-import batch; deleting the `shift_imports` row undoes just those shifts. Caps and swap posts NOT batch-undoable.

## Known gotchas (already shipped as bugs — don't rediscover)

- Astro `<style>` blocks never apply to innerHTML-built content. CSS for script-generated markup MUST live in `src/styles/global.css`.
- CSS comment containing literal `*/` truncates the rest of the stylesheet. Verify comment balance after every edit: `(css.match(/\/\*/g)||[]).length === (css.match(/\*\//g)||[]).length`.
- `local.js` update fns must merge field-by-field (`if (updates.field !== undefined) row.field = updates.field`), never `Object.assign(row, updates)` — partial update objects carry `undefined` keys.
- `neon.js` raw SQL UPDATE must explicitly SET every column meant to survive (`updates.x ?? row.x`).
- Shift-to-template matching is CONTAINMENT (`start >= template.start && end <= template.end`), never any-overlap.

## Verification before "done"

1. `npm run build` — catches Astro/type errors.
2. If touched `src/styles/global.css`: check comment balance.
3. If touched `src/lib/db/*`: verify against BOTH `local.js` and `neon.js`.
4. UI changes: run dev server, click/drag/right-click the feature, check browser console.
5. Bulk-import changes: hit endpoint with real payload + a deliberately-bad row.

## UI rules (owner preference — apply to every component, every commit)

**No emoji anywhere in rendered UI — use inline SVG icons.** The owner has corrected this twice ("i told oyu to use SVGs only"). Every icon — paperclip, file type indicators, status pills, alert glyphs, close buttons — must be a `<svg>` element with `viewBox="0 0 24 24"`, `stroke="currentColor"`, sized via CSS. No `📎`, no `📄`, no `🖼️`, no `⚠`, no `✓`, no `×` character either (use a 2-line SVG for the close X). Define one `SVG` icon map at the top of the script and dispatch by MIME / status; never inline `<svg>` literals at call sites. Typographic punctuation (`—`, `…`, smart quotes) is also out — use ASCII (`-`, `...`, straight quotes).

**Default scope is narrower than the request.** The owner pushes back when a feature grows beyond its stated need (e.g. "the schedule app doesn't need music files, just photos or documents"). When asked for a feature, implement exactly the scope given — don't add adjacent file types, icons, or affordances unprompted. If the requested feature could be broader and the broader version would obviously be useful, ship the narrow version first and surface the broader option in the reply, not in the code.

**Server response returns the canonical record; the UI renders from that.** When a message has attachments, the chat panel fetches them via the same `GET /api/agent/chat` call (one batch lookup, key by message_id) and renders thumbnails / chips from the response. Don't have the UI maintain a separate "pending attachment" DOM tree after send — once the message is posted, the server's view is truth.

## Self-documenting guide

The app exposes its own live guide (regenerated from `src/lib/agentGuide/registry.js`):
- `GET /api/agent-guide` (JSON)
- `GET /api/agent-guide/markdown` (human-readable markdown)

**Prefer fetching this from the deployment I'm actually talking to** — it reflects the exact API of that instance.

## How to actually USE this skill

When user says things like:
- "Add Jorge Friday 11-7" → `POST /api/shifts` (or bulk import) with user_id resolved via GET /api/state
- "Schedule next week" → fetch live guide, build rows, POST to `/api/public/shift-imports`
- "Cancel my shift request" → find by GET /api/state, then DELETE
- "Make Friday lunch cap 2 people" → bulk import with `type: cap` row

Don't ask the human to reformat files. Read spreadsheets/photos/CSVs yourself, build canonical rows, POST.

Approval flow: when a request "needs approval," tell the user where to find it in the Schedule Builder — don't call approve endpoints.

## Chat orchestration architecture (the AI bot in the bottom-right of every page)

A manager types into a chat panel embedded globally via `Layout.astro`. The orchestrator (this Vercel function) decides where the message goes:

**Three modes (set in Settings → Chat Source):**
- `hermes` — POST to a local Cloudflare Tunnel URL (free, runs on the user's Mac; Mac must be on)
- `cloud` — Direct API call to Claude/OpenAI/MiniMax using a key in `app_settings` (per-token billing)
- `hybrid` — Try Hermes first; if tunnel doesn't respond within ~3s, fall back to cloud

**The payload sent to whichever AI runs:**
```js
{
  message: { id, role, content, user_id, username, display_name },
  history: [ { role, content }, ... ],        // last 10 turns, JSON blocks stripped
  state: {
    users: [{ username, display_name, role }],
    shiftTemplates: [...],
    upcomingShifts: [...]                       // next 30 days
  },
  guide: "...full AGENT-TRAINING.md text..."     // ~17KB, regenerated from registry.js
}
```

**The contract the AI returns:**
```js
{
  content: "your reply shown to the manager",
  actions: [
    { method: "POST", endpoint: "/api/shifts",
      body: { user_id, date, start_time, end_time },
      summary: "Scheduled Jorge Friday 11-7pm" }
  ]
}
```

The orchestrator extracts the `actions[]` from the reply, executes each via the app's own `/api/*` routes **using the caller's session cookie** (so audit attribution is correct), then writes the assistant row + per-action audit log to the DB. The chat UI's SSE stream watches for the row and renders tokens as they arrive.

**Code locations:**
- `src/pages/api/agent/chat/index.js` — POST sends, GET history, full orchestration
- `src/pages/api/agent/chat/stream.js` — SSE — chat UI watches for assistant rows
- `src/components/AgentChatPanel.astro` — floating chat UI on every page
- `src/lib/agentChat.js` — data layer (dual-backend: neon.js + local.js)
- `src/pages/api/admin/settings/chat-source.js` — Hermes/Cloud/Hybrid picker
- `src/pages/api/admin/settings/tunnel.js` — Cloudflare Tunnel URL
- `src/pages/api/admin/settings/ai.js` — provider + API key
- `src/lib/settingsCrypto.js` — AES-256-GCM encryption for the stored key

## Patterns that saved time on this codebase

**Vercel serverless timeout:** hobby plan is 60s; orchestrator must complete within ~55s. Keep AI calls under 30s (use short `max_tokens`). SSE streams need explicit `: keep-alive` ping every 15-20s or Vercel kills the connection.

**Astro frontmatter must be ONE block.** Multiple `---` separators cause everything between them (including pure `//` JS comments) to render as visible text on every page that mounts the component. Keep all imports + interface + const in one frontmatter block.

**`src/lib/db/index.js` exports `default` and `usingLocalDb`.** Consumers must use `import dbCore from '...'` (default import). `import * as dbCore` returns `{default: backend, usingLocalDb}` and `dbCore.getSetting` is `undefined` → `TypeError: undefined is not a function` at runtime. Same default-import pattern is required for every `src/lib/db/*` consumer.

## Skill gotchas (these broke builds in production — re-deriving any of them = wasted hour)

- **Astro `<style>` blocks never apply to `innerHTML`-built content.** A page's scoping attribute only lands on elements present at Astro *build* time; anything a client `<script>` builds via `innerHTML` (the Schedule Builder's whole calendar grid, for one) silently never matches a scoped style. Any CSS for script-generated markup must live in the global, unscoped `src/styles/global.css`.
- **CSS comment containing literal `*/` truncates the rest of the stylesheet.** e.g. writing `.card/.btn-*/.modal` inside a `/* ... */` comment closes it early at the `*/` that `.btn-*` + `/` accidentally forms — everything after it silently disappears from the parsed stylesheet even though the raw file text looks fine. **After every edit to `global.css`, verify comment balance**: `(css.match(/\/\*/g)||[]).length === (css.match(/\*\//g)||[]).length`.
- **`local.js` update fns must merge field-by-field** (`if (updates.field !== undefined) row.field = updates.field;`), never `Object.assign(row, updates)` — partial update objects carry `undefined` keys; a blind Object.assign copies those `undefined`s over the existing values, wiping them. Mirror the same pattern in `neon.js`.
- **`neon.js` raw SQL UPDATE must explicitly SET every column meant to survive**, falling back to the existing row's value (`updates.x ?? row.x`) for anything not being changed. A column simply left out of the `UPDATE ... SET` text is never touched in Postgres, so it's easy to add a new partial-update caller against a `neon.js` function that was only ever written to update two of a row's five columns and have it silently no-op the rest.
- **Shift-to-template matching is CONTAINMENT** (`start >= template.start && end <= template.end`), never any-overlap — a real bug shipped once when an unrelated shift touching part of a template's hours was wrongly counted against its capacity.
- **`db/index.js` exports `default`** — see the code-pitfalls section above.
- **After a feature batch that renames or adds tables, verify the deployed Neon DB has the new schema before debugging code.** A `/api/state` response shaped like `{"users": 0, "shifts": 0, ..., "keys": ["error"]}` after a deploy that touched the data model usually means the new table doesn't exist on Neon — `db/schema.sql` ships in the repo but `apply-schema.mjs` was never run against the production DB. Don't assume the Vercel env is misconfigured (`DATABASE_URL` is set) or that the query is wrong until you've confirmed the new tables exist: `psql "$DATABASE_URL" -c "\dt"` or the Neon SQL editor. The fix is `node db/apply-schema.mjs` against the deployed DB, then redeploy is usually NOT required (only data migration, not code).
- **A new data-layer function touches THREE files, not one.** Any new function in `src/lib/db/neon.js` MUST also be implemented in `src/lib/db/local.js` (identical signature, JSON-file vs Postgres semantics) AND re-exported through the relevant domain module (`src/lib/agentChat.js` for chat, etc.). A function that's only in one backend crashes at runtime when the other backend is selected. Likewise, `db/schema.sql` must include the table with `IF NOT EXISTS`; `apply-schema.mjs` is idempotent and only adds.
- **Adding a feature that requires uploading files in the chat panel means EIGHT files in one change.** Add the table to `db/schema.sql` + re-run `apply-schema.mjs` against production Neon. Add CRUD functions to BOTH `neon.js` and `local.js`. Re-export through `src/lib/agentChat.js`. Add an upload endpoint at `src/pages/api/<feature>/upload.js` (POST, multipart, `export const config = { api: { bodyParser: false } }`, write to `os.tmpdir()`). Add a serve endpoint at `src/pages/api/<feature>/[id].js` (GET, stream from disk, auth = uploader OR admin/manager, return 410 Gone if file vanished). Add the field to the data layer's re-exported functions. Update the GET aggregate endpoint to return the file list (batch lookup keyed by message_id, not per-message). Update the orchestrator to include file metadata + base64 (≤2MB) in the AI payload. Update the UI to render the icon, thumbnail, or chip. Files on Vercel serverless live in `/tmp` (tmpfs, ephemeral, survives only within a warm instance) — see `vercel-deploy` skill's storage pitfall; for persistent files, swap to Cloudflare R2.