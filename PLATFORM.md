# Scheduling Platform — Build Spec

## What we're building
Multi-tenant SaaS. One codebase, deployed per-customer on Vercel, each with
its own Neon Postgres database. Customer signs up → gets their own isolated
instance in <60s.

## Repo
`andshawarmaai/scheduling-app` (already created)

## Stack (decisions made, no more questions)
- **Frontend/backend:** Astro 5 SSR (replaces static-only mode)
- **Adapter:** `@astrojs/vercel` (serverless functions on Vercel)
- **DB:** Neon serverless Postgres + `@neondatabase/serverless`
- **ORM:** Drizzle ORM + drizzle-kit migrations
- **Auth:** username + bcrypt password, signed session cookie (HttpOnly, Secure, SameSite=Lax)
- **Validation:** Zod for request body validation
- **Per-customer isolation:** schema-per-customer in Neon (each customer gets their own DB; we never query across)

## Provisioning flow
Customer signup → script does:
1. POST Neon API → create project in `andshawarma` org, pick closest region
2. Capture `DATABASE_URL` from response
3. POST Vercel API → create project, link to `andshawarmaai/scheduling-app`
4. Set env vars: `DATABASE_URL`, `SESSION_SECRET`, `TENANT_NAME`, `TENANT_SLUG`
5. Trigger initial deploy
6. Run Drizzle migration on new DB (creates schema)
7. Bootstrap first admin user (password emailed)
8. Return `https://<slug>.vercel.app` + admin login

## Database schema (per tenant DB)
```
users        id, username, password_hash, full_name, role, phone, email, active, created_at
shifts       id, user_id, starts_at, ends_at, role, notes, status, submitted_by, decided_by, decided_at, decision_note, created_at
time_off     id, user_id, starts_at, ends_at, reason, notes, status, submitted_by, decided_by, decided_at, decision_note, created_at
sessions     id, user_id, expires_at, created_at
```

(Direct port of current `data.json` types + sessions table for new auth.)

## API endpoints (replaces `data.json` reads/writes)
```
POST   /api/auth/login        → {username, password} → sets session cookie
POST   /api/auth/logout
GET    /api/me                → current user
GET    /api/users             → list (manager only)
POST   /api/users             → create (manager only)
PATCH  /api/users/:id         → update role/active (manager only)

GET    /api/shifts?from=&to=  → list (scoped to tenant DB)
POST   /api/shifts            → create
PATCH  /api/shifts/:id        → update status (approve/deny)
DELETE /api/shifts/:id

GET    /api/time-off
POST   /api/time-off
PATCH  /api/time-off/:id
```

## White-label (existing config preserved)
`whitelabel.config.json` → read at build time → injected as `import.meta.env.PUBLIC_*`
via Vercel env vars per-customer. Each customer gets their own colors/logo/business name.

## Migration of existing data
Skip. Current `data.json` is a single customer (you). New customers start empty.
After migration is proven, write one-time importer.

## Timeline
- Step 1: scaffold backend in repo (install deps, add API routes, add adapter) → 60 min
- Step 2: Drizzle schema + migration runner → 30 min
- Step 3: Auth (bcrypt + session cookies) → 45 min
- Step 4: Replace `data.json` reads/writes in existing pages with API calls → 60 min
- Step 5: Test full flow locally + Vercel preview deploy → 30 min
- Step 6: Provisioning script (Neon + Vercel APIs) → 60 min
- Step 7: Smoke test end-to-end with a fake customer → 30 min

Total: ~5–6 hours of focused work. Will ship incrementally and show you
working endpoints after each step.
