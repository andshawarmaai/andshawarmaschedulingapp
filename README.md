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

### How the database connection actually works

There is no "install a password" step to do by hand — Neon and Vercel
handle the database credential for you. The full chain:

1. `vercel integration add neon` creates a real Postgres database on
   Neon's infrastructure, with Neon generating its own username +
   password for it. You never see or choose this password.
2. Vercel writes that connection as a **connection string** — a single
   URL with everything embedded: `postgresql://user:password@host/dbname?sslmode=require`
   — into this Vercel project's environment variables, as `DATABASE_URL`
   (a pooled connection, for the running app) and `DATABASE_URL_UNPOOLED`
   (a direct connection, for one-off scripts like `db/apply-schema.mjs`).
3. `src/lib/db/index.js` checks `process.env.DATABASE_URL` at runtime: if
   it's set, every database call goes to Neon over that connection
   string; if it's unset (e.g. plain local dev), it falls back to a local
   JSON file instead. **This is the only thing that decides which
   database the app talks to** — there's no separate config file, no
   hardcoded host, nothing else to point anywhere.
4. `vercel env pull .env.local` downloads whatever's currently set on the
   Vercel project (including that `DATABASE_URL`) into a local file, so a
   one-off script run from a terminal (like `db/apply-schema.mjs` or
   `db/seed.mjs`) can read `process.env.DATABASE_URL` the same way the
   deployed app does.

So "installing" the database connection is really just: run the
integration once (step 2 above), and everything downstream reads that
same `DATABASE_URL` automatically. If a deploy can't reach the database,
the fix is never to hand-edit a password — it's to confirm `DATABASE_URL`
exists on the project (`vercel env ls production`) and, if not, redo the
Neon integration step.

`SESSION_SECRET` is unrelated to the database — it's a value **this app
generates itself** (a random 32-byte hex string) purely to sign session
cookies, so it never depends on Neon or Vercel at all; it's just stored
as a Vercel environment variable the same way `DATABASE_URL` is, so both
reach the running app the same way.

### Environment variables reference

| Variable | Required? | Where it comes from | Read by |
|---|---|---|---|
| `DATABASE_URL` | Yes in production | Auto-set by `vercel integration add neon` | `src/lib/db/index.js` |
| `DATABASE_URL_UNPOOLED` | No (Neon sets it alongside `DATABASE_URL`) | Same as above | not used directly by app code |
| `SESSION_SECRET` | Yes in production | Generate yourself (see step 3), set via `vercel env add` | `src/lib/session.js` |
| `LLM_PROVIDER` | No | You choose: `anthropic` or `openai` | `src/lib/llm/index.js` |
| `ANTHROPIC_API_KEY` | Only if `LLM_PROVIDER=anthropic` | Your Anthropic account | `src/lib/llm/anthropic.js` |
| `OPENAI_API_KEY` | Only if `LLM_PROVIDER=openai` | Your OpenAI account | `src/lib/llm/openai.js` |
| `LLM_MODEL` | No | Optional override of that provider's default model | `src/lib/llm/anthropic.js` / `openai.js` |

Nothing here is a shared/global secret — every value above is scoped to
one Vercel project, so a second deployment (a different customer, a
different environment) gets entirely its own copies with no overlap.

### Troubleshooting: Vercel ↔ Neon fails with something that looks like an auth problem

This is almost always **not** an account/credentials problem — it's
Vercel requiring a one-time human approval that got skipped:

- Vercel requires accepting a marketplace integration's terms
  **interactively**, the first time any given Vercel *team* installs it —
  this is true even if that Vercel account has Neon connected on some
  *other* team or project already; approval is per-team, not per-account.
- If `vercel integration add neon` was ever run with `--non-interactive`,
  in CI, or through anything that isn't a real terminal, that approval
  prompt has nowhere to appear and the command fails — sometimes with an
  error that reads like an authentication failure rather than "you need
  to approve this."

**Fix**: run `vercel integration add neon` yourself, plain, no flags, in
an actual interactive terminal. Accept whatever prompt or browser tab it
opens. Then re-run `npm run setup` (or just `vercel env pull .env.local`)
— it picks up from there.

If it fails a *different* way — something that specifically mentions a
password, role, or permission error rather than a missing approval —
that usually means a previous attempt partially created a Neon resource
without finishing the link. Check both places for a leftover/orphaned
one and delete it before retrying:
- Vercel dashboard → this project → **Storage** tab
- https://console.neon.tech → your projects list

After fixing either case, environment variables only take effect on a
fresh deploy — run `npm run setup` again (or `vercel --prod --yes`) once
`DATABASE_URL` shows up in `vercel env ls production`.

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
