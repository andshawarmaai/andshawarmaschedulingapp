# &Shawarma — Staff Scheduling

A staff scheduling app for a single restaurant: shifts, time-off requests,
shift swaps, and an admin panel — with a bulk CSV importer and a
per-admin Telegram bot (with optional LLM-powered natural language) so an
AI assistant can update the schedule without anyone opening the UI.

This doc is written so a developer **or an AI coding agent** can deploy
this from a completely empty state with no prior context. Every command
below is meant to be copy-pasted or run verbatim.

## Stack

- **Astro 5** (`output: 'server'`) + `@astrojs/vercel` adapter
- **Auth**: HMAC-signed session cookies (`src/lib/session.js`) verified in
  `src/middleware.js` on every request — there is no client-side-only auth
  anywhere, so navigating straight to a URL can never bypass login
- **Database**: dual backend (`src/lib/db/index.js`) — a local JSON file
  with zero setup when `DATABASE_URL` is unset, or Neon Postgres in
  production. Both backends implement identical function signatures.
- No other runtime dependencies beyond `bcryptjs` for password hashing.

## Local development (no database needed)

```bash
npm install
npm run dev
```

Opens on `http://localhost:4321`. With no `DATABASE_URL` set, it
auto-creates `db/.local-data.json` on first request, seeded with the
original roster — every account's password equals its username (e.g.
`ray` / `ray`). This file is gitignored; delete it any time to reset to a
fresh seed.

## Deploying to Vercel + Neon

### The fast way

```bash
npm install
vercel login          # skip if already logged in
npm run setup
```

`scripts/setup.mjs` is a resumable deployment wizard — a human or an AI
agent can just run it from a completely clean checkout. It links the
Vercel project, provisions a Neon database through Vercel's marketplace
integration (billed to whichever Vercel account runs this — no separate
Neon signup), generates and sets `SESSION_SECRET`, applies the database
schema, seeds the first accounts, and deploys to production.

It checks each step's current state before acting, so it's **safe to
re-run** — if it stops partway (e.g. Neon's marketplace integration needs
a one-time browser approval on first install), do that one thing and run
`npm run setup` again; it picks up exactly where it left off instead of
redoing anything.

The only manual step it can't do for you: if `vercel login` needs a
browser to complete, that has to happen once, interactively, before the
wizard can authenticate.

### What it's doing, step by step (for reference / manual runs)

```bash
vercel link
```

Follow the prompts to create a new project (or link an existing one) under
the correct team/account.

### 2. Provision Neon through Vercel's integration

```bash
vercel integration add neon
```

This creates a Neon Postgres database tied to the same Vercel
account/team and automatically sets `DATABASE_URL` (and
`DATABASE_URL_UNPOOLED`) as environment variables on the project — no
separate Neon signup needed, and its usage bills to whichever Vercel
account ran this command.

### 3. Set the remaining required environment variable

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
vercel env add SESSION_SECRET production
```
(paste the generated value when prompted). The app throws on boot in
production without this set — it signs every session cookie.

Optional environment variables — see `.env.example` for the full list
with explanations (LLM provider keys for the Telegram natural-language
feature; none of these are required for the app to run).

### 4. Apply the database schema

Pull the `DATABASE_URL` Vercel just created into a local `.env.local`:

```bash
vercel env pull .env.local
```

Then apply the schema and seed the first accounts:

```bash
set -a && source .env.local && set +a
node db/apply-schema.mjs
node db/seed.mjs
```

`db/seed.mjs` prints each generated username/password **exactly once** —
copy them immediately, they are bcrypt-hashed and unrecoverable after
this. It does nothing (safely) if the `users` table isn't empty, so it's
safe to re-run.

### 5. Deploy

```bash
vercel --prod --yes
```

### 6. Verify

Visit the deployed URL, log in with one of the seeded accounts, and
confirm the schedule loads. `GET /api/admin/shift-import-template` (while
logged in as admin/manager) should return a CSV with the real roster
baked into its comments — that's a quick sanity check that
`DATABASE_URL` is wired correctly.

## Project structure

```
src/middleware.js          Server-side auth gate — runs before every request
src/lib/session.js         Signs/verifies the session cookie
src/lib/db/index.js        Picks local-JSON vs Neon backend by DATABASE_URL
src/lib/db/local.js        Local JSON file backend (dev only)
src/lib/db/neon.js         Neon Postgres backend (production)
src/lib/shiftImport.js     CSV/command row validation shared by every import path
src/lib/apiKey.js          API-key generation/verification (agent access)
src/lib/telegram.js        Telegram Bot API wrapper
src/lib/llm/               Pluggable LLM backend for natural-language Telegram messages
src/pages/api/             All API routes (see below)
src/pages/*.astro          UI pages
db/schema.sql              Full Postgres schema — the source of truth for table shape
db/apply-schema.mjs        Applies schema.sql against DATABASE_URL (idempotent)
db/seed.mjs                One-time script to create the first accounts in Neon
db/roster.mjs              The original staff roster used by both seed paths
scripts/setup.mjs          Resumable deployment wizard (`npm run setup`)
```

### Three ways external systems can change the schedule

1. **CSV upload in the UI** — Manage → Bulk Schedule Import. Session-authenticated.
2. **API key** — `POST /api/public/shift-imports` with
   `Authorization: Bearer shwrm_...` and a CSV or JSON body. Keys are
   created/revoked in Manage → API Keys. Built for an external AI agent
   (e.g. "Hermes") to post a bulk update without a login session.
3. **Telegram bot** — Manage → Telegram Bots (admin-only). Each admin
   connects their own bot (from @BotFather); understands `/shift`, `/cap`,
   `/swap` commands always, and free-form natural language when an LLM
   provider is configured (see `.env.example`).

All three funnel through the same validation in `src/lib/shiftImport.js`,
so a bad row is rejected identically regardless of which path sent it.

## Security notes

- Every write is gated by the signed session cookie + role check in
  `src/middleware.js`, not by browser origin checks (`security.checkOrigin: false`
  in `astro.config.mjs` is intentional — see the comment there).
- API keys and Telegram webhook secrets are the only two ways to write to
  this app without a login session; both are scoped, individually
  revocable, and logged.
- Passwords are bcrypt-hashed; nothing plaintext is ever stored past
  creation time (account creation, `db/seed.mjs`, and password resets all
  print/show a password exactly once).
