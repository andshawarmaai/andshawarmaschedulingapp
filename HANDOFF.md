# &Shawarma Scheduling App - Handoff Brief

**Date:** 2026-09-21
**For:** Next agent or human picking this up cold
**Why this file exists:** the owner may run out of tokens/credits mid-session and wants a clean handoff so a fresh agent can continue the same thread of work without re-deriving context from scratch.

---

## Read this first, in order

1. **This file** - recent history, current state, how to keep going.
2. **`CLAUDE.md`** (repo root) - the living technical reference: full data model, every business rule already built, known gotchas, deployment topology. Sections 11, 12, and 13 (added 2026-09-21) document the Cloudflare Tunnel integration, chat attachments, and the corrected single-repo deployment topology. It is kept up to date after every change **in the same commit as the change** - if something here and in `CLAUDE.md` ever disagree, trust `CLAUDE.md`, it's newer.
3. **`git log --oneline -30`** - every commit message is self-explanatory; skimming them is a fast way to see the actual sequence of fixes.

Do not re-explore the codebase from scratch before reading `CLAUDE.md` - it already answers "how does X work," "why is Y built this way," and "what already exists" for nearly everything in this app.

---

## What this is (one paragraph)

A single-restaurant staff scheduling app: Astro 5 (server output) + Vercel + Neon Postgres. Staff submit availability/time-off; an admin/manager builds the real schedule and approves/denies everything from one place, the Schedule Builder (`/admin/schedule`). Deployed to **one** Vercel project (`andshawarmaschedulingapp`) backed by **one** Neon database. The chat bot routes messages through a local Hermes bridge running on the owner's Mac, accessed via a Cloudflare quick tunnel (URL rotates on restart; a LaunchAgent watches and pushes the new URL to the app automatically).

## Current state (as of this handoff)

- Working tree has uncommitted changes in `src/middleware.js` and an untracked `src/pages/api/_debug/` directory - **discard these, they are leftover from earlier debugging and not part of any feature.**
- Latest commit on `main`: `ccbec17` - "Replace emoji icons with inline SVGs; narrow to photos+PDFs+text docs"
- Latest production deploy: live at `https://andshawarmaschedulingapp.vercel.app` (the only Vercel alias; commit `ccbec17`).
- `npm run build` passes clean as of the last commit.
- Customer-facing Neon DB has the new `agent_chat_attachments` table applied (schema.sql is idempotent via `IF NOT EXISTS`).
- The owner's Mac has the bridge running on port 7890 (`scripts/hermes-bridge.mjs`) and a cloudflared tunnel running via LaunchAgent.

## What just happened (2026-09-21 session)

This session was focused on three things:

1. **Cloudflare Tunnel integration.** The owner's local Hermes bridge (Mac, port 7890) needed to be reachable from the Vercel-hosted app so chat messages could route through the owner's own LLM subscription instead of paying per-message for a cloud provider. Built and shipped:
   - `cloudflared` tunnel auto-restart LaunchAgent + URL watcher LaunchAgent
   - `POST/GET/DELETE /api/admin/settings/tunnel` endpoint with encrypted storage, health probing, mode detection (tunnel/cloud/hybrid/offline)
   - `POST /api/admin/settings/chat-source` mode picker (Hermes / Cloud / Hybrid)
   - `/api/agent/chat` orchestrator updated to route via Hermes or Cloud based on settings
   - The current tunnel URL is whatever `cloudflared --url` printed last; the watcher keeps `/api/admin/settings/tunnel` in sync.

2. **Chat attachments.** Added file uploads to the chat bot so staff and managers can send photos of the schedule, PDFs, text documents. Built and shipped:
   - `agent_chat_attachments` table (schema.sql)
   - `POST /api/agent/chat/upload` multipart endpoint (10MB cap, writes to `/tmp/chat-uploads/`)
   - `GET /api/agent/chat/attachments/[id]` streaming serve endpoint with auth
   - UI in `src/components/AgentChatPanel.astro`: paperclip button, drag-drop, mobile camera capture (`capture="environment"`), pending attachment chips, inline thumbnails / file chips in chat bubbles
   - Orchestrator reads files from disk and inlines base64 (≤2MB) into the agent payload

3. **Cleanup.** The session created an extra Vercel project (`andshawarma-scheduling`, no hyphen) by mistake during initial deployment; it was deleted. Only `andshawarmaschedulingapp` (scheduling) and `work-buddy` (restaurant ops) remain under the Vercel team.

## How to keep working on this

### Local dev
```bash
npm install   # if node_modules isn't present
npm run dev   # → http://localhost:4321, local.js backend (db/.local-data.json), auto-seeds 11 test users
```

### Verifying a change
1. `npm run build` - catches Astro/type errors immediately. (See CLAUDE.md §12 for the full pre-commit checklist.)
2. For UI changes: run the dev server, click/drag/right-click the feature, check the browser console for errors - don't rely on a clean build alone.
3. For DB changes: sanity-check both `src/lib/db/local.js` and `src/lib/db/neon.js` (a bug can exist in one and not the other - this happened twice already).
4. For attachment/tunnel changes: smoke-test the live endpoints via curl before claiming the feature works.

### Deploy
1. Commit + push to `origin` (`andshawarmaai/andshawarmaschedulingapp`). There is NO customer repo anymore - the `therayally/andshawarmatest` remote is orphaned and `git push customer` will 403. The single deploy target is `origin`.
2. Deploy:
   ```bash
   cd /Users/testuser/andshawarma-scheduling && /Users/testuser/.local/node_modules/.bin/vercel deploy --prod --yes --token "$VERCEL_TOKEN"
   ```
   Deploys to `prj_myeSrvOqeHDVKRTuZNm7UdpWPHw6` (the `andshawarmaschedulingapp` project).
3. Verify at `https://andshawarmaschedulingapp.vercel.app/login` after deploy completes.

### The dev box vs this machine
This is the **owner's Mac** (Hermes-running, `testuser@Rays-MacBook-Air`). It owns the tunnel, the bridge, and the Vercel deploy credentials. The **dev box** is whatever machine the user is reading this on next - it does NOT have cloudflared, the bridge, or the Vercel token. It pulls from `origin` via `git pull` and runs the dev server locally.
