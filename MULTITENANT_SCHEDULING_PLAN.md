# Multi-tenant scheduling plan (future work — not started)

**Status:** Planning only. Nothing in this doc has been built yet. Read this
first, before starting the work, whenever this gets picked up.

## The decision

**Subdomain-per-customer, not shared-database multi-tenancy.**

Each customer (restaurant) gets:
- Their own subdomain: `customername.yourdomain.com`
- Their own Vercel deployment
- Their own Neon database
- Their own login, completely isolated from every other customer
- The ability to connect their own local Hermes, same "Set up Hermes" flow
  that already exists today — nothing about this model blocks that

**Why this over one shared database with tenant isolation:** true
multi-tenancy (one DB, every table scoped by a `tenant_id` column, tenant-aware
auth) is a real data-model rewrite and a much bigger security surface — one
missed `WHERE tenant_id = ?` and one customer sees another's data. The
subdomain-per-customer model reuses almost everything that already exists
(this app was already built as "one deployment = one restaurant") and turns
the problem into provisioning automation instead of a schema rewrite.

**Revisit this decision if:** customer count gets large enough that running
N separate Vercel deployments + N separate Neon databases becomes expensive
or operationally annoying. That's the point to consider migrating to real
multi-tenancy — not before.

## What already supports this today (verified, not assumed)

- The app is already single-tenant-per-deployment by design (see CLAUDE.md).
- `training-data/` (the chat bot fine-tuning work) is already brand-neutral —
  no restaurant name baked in anywhere, built specifically for this reuse.
- The "Set up Hermes" flow (`src/pages/api/admin/hermes-setup.js`,
  `public/install-relay.sh`) already generates a fresh API key and the
  correct install command **per-deployment**, dynamically — nothing
  hardcoded. Confirmed via `src/lib/publicOrigin.js` (added 2026-09-25),
  which fixed a real bug where the command used to resolve to
  `https://localhost` instead of the actual deployment's URL. As long as
  each customer gets their own deployment, this already works with zero
  extra engineering.

## What needs to be built

1. **Buy one domain** (if not already owned) for the product itself — e.g.
   `yourschedulingapp.com`. Not the same as the &Shawarma-specific domain
   already owned for that one restaurant's chat bot relay.
2. **Wildcard DNS**: `*.yourschedulingapp.com` → the provisioning/router layer
   (see #4).
3. **A provisioning script/flow** — given a new customer's name + admin
   login details, it should:
   - Create a new Neon database (Neon has an API for this — branch or
     project creation)
   - Run `db/schema.sql` + seed an initial admin user against it
   - Create a new Vercel project (or a new deployment target) wired to the
     chosen subdomain
   - Set the required env vars (`DATABASE_URL`, `SESSION_SECRET`, per
     CLAUDE.md's "Required env vars") for that new project
   - Return the customer their subdomain + login
4. **Routing**: decide whether each customer is a genuinely separate Vercel
   project (simplest, matches today's model exactly) or one Vercel project
   with per-request subdomain routing to different databases (more complex,
   only worth it if Vercel's per-project overhead becomes a real cost/limit
   problem at scale — default to separate projects first).
5. **Billing** — out of scope for this doc; a real, separate decision
   (Stripe subscriptions per subdomain, etc.) once the provisioning flow
   itself works.
6. **A simple internal "create new customer" admin tool** — doesn't need to
   be customer-facing self-serve on day one; a script you run yourself per
   new signup is a fine v1.

## Explicitly not part of this plan

- Making `andshawarmaai/andshawarmaschedulingapp` (the &Shawarma restaurant's
  own deployment) multi-tenant. That one stays exactly as it is — one
  restaurant, one deployment, per the user's explicit instruction
  ("not on the &Shawarma side").
- Real shared-database multi-tenancy — deliberately deferred, see "Revisit
  this decision if" above.
- Which specific repo (`andshawarmaai/andshawarmaschedulingapp` vs.
  `therayally/scheduling-app`) becomes the base for this product. That's a
  separate, still-unresolved question from today's session (two GitHub repos
  currently both deploy to the same Vercel project, which needs sorting out
  before this plan should start) — resolve that first.

## First real step when this gets picked up

Sort out the two-repos-one-Vercel-project situation (see
`CHAT_BOT_HANDOFF_*.md` docs and today's conversation for context) so there's
one unambiguous source-of-truth repo to build the provisioning flow from.
Starting the provisioning work before that's settled would mean building on
top of the same confusion that caused today's deploy problems.
