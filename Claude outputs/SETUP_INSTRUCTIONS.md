# Schedule App - Setup Instructions

## What was built

A complete, production-ready shift scheduling application with:

- **Astro 5.x** framework with `output: 'server'` for SSR
- **@astrojs/vercel** adapter for seamless Vercel deployment
- **Neon Postgres** serverless database with auto-schema initialization
- **Session-based authentication** with Argon2 password hashing
- **Role-based access control**: owner, manager, staff
- **Customizable branding** per deployment (colors, logo, business name, etc.)
- **Full shift management**: scheduling, time-off requests, shift swaps
- **Tailwind CSS v4** with dynamic branding colors
- **TypeScript** strict mode throughout
- **Path aliases** (@/*) configured in tsconfig and astro.config

## Files Included

`schedule-app-source.tar.gz` contains the complete source code. Extract it:

```bash
tar -xzf schedule-app-source.tar.gz
cd schedule-app
```

## Getting it on GitHub

The code is ready to push to https://github.com/andshawarmaai/scheduling-app

### Option 1: Push from Your Machine

1. Extract the tarball locally
2. Open terminal in the `schedule-app` directory
3. Set git remote:
   ```bash
   git remote add origin https://github.com/andshawarmaai/scheduling-app.git
   git branch -M main
   git push -u origin main
   ```

### Option 2: Create Repo on GitHub First

1. Go to https://github.com/new
2. Name it `scheduling-app` under the `andshawarmaai` organization
3. Do NOT initialize with README, .gitignore, or license
4. Follow Option 1 steps above

## Project Structure

```
schedule-app/
├── astro.config.mjs          # Astro config with Vercel adapter & path aliases
├── tsconfig.json             # TypeScript with path aliases
├── package.json              # Dependencies
├── README.md                 # With Deploy to Vercel button
├── .env.example              # POSTGRES_URL template
├── .gitignore                # Ignores node_modules, dist, .env, etc.
├── src/
│   ├── middleware.ts         # Session auth, redirects, branding loader
│   ├── env.d.ts              # TypeScript types for Astro.locals
│   ├── layouts/
│   │   └── AppLayout.astro   # Main layout with branding header
│   ├── pages/
│   │   ├── index.astro       # Redirect logic
│   │   ├── setup.astro       # Initial setup form
│   │   ├── login.astro       # Login page
│   │   ├── schedule.astro    # Weekly schedule view
│   │   ├── time-off.astro    # Time-off requests
│   │   ├── swaps.astro       # Shift swap marketplace
│   │   ├── admin/
│   │   │   ├── index.astro   # Admin dashboard
│   │   │   ├── users.astro   # User management
│   │   │   ├── schedule.astro # Schedule builder
│   │   │   ├── requests.astro # Request approvals
│   │   │   └── branding.astro # Branding editor
│   │   └── api/
│   │       ├── auth/
│   │       │   ├── login.ts
│   │       │   ├── logout.ts
│   │       │   └── setup.ts
│   │       ├── users.ts
│   │       ├── shifts.ts
│   │       ├── time-off.ts
│   │       ├── time-off/[id].ts
│   │       ├── swap.ts
│   │       ├── swap/[id]/claim.ts
│   │       ├── swap/[id]/approve.ts
│   │       └── branding.ts
│   ├── lib/
│   │   ├── db/
│   │   │   ├── client.ts     # Neon query builder & schema initialization
│   │   │   └── schema.sql    # Full database schema
│   │   ├── server/
│   │   │   ├── auth.ts       # Password hashing, sessions, roles
│   │   │   └── branding.ts   # Load & update branding
│   │   └── types.ts          # TypeScript interfaces
│   └── styles/
│       └── global.css        # Tailwind + CSS variables for branding
└── public/                   # Static assets (customer puts logo here)
```

## Build Status

✓ Builds successfully: `pnpm build` runs without errors
✓ Ready for Vercel: @astrojs/vercel adapter configured
✓ Database ready: Schema auto-runs on first request
✓ All routes implemented: Setup, auth, schedule, admin, API endpoints
✓ Branding system: Dynamic CSS variables throughout UI
✓ TypeScript strict mode: All files type-safe

## Next Steps

### 1. Push to GitHub

```bash
cd schedule-app
git remote add origin https://github.com/andshawarmaai/scheduling-app.git
git branch -M main
git push -u origin main
```

### 2. Create Vercel Project (or use Deploy Button)

Option A: Deploy Button (one-click)
- Once on GitHub, README has a "Deploy to Vercel" button
- Click it → login to Vercel → paste Neon connection string → done

Option B: Manual Vercel Setup
- Go to https://console.vercel.com
- Click "Add New..." → "Project"
- Import GitHub repo `andshawarmaai/scheduling-app`
- Add environment variable `POSTGRES_URL` (get from Neon)
- Deploy

### 3. Get Neon Database URL

- Go to https://console.neon.tech
- Sign up (free, no credit card)
- Create new project
- In dashboard, copy the connection string
- Format: `postgresql://user:pass@ep-xxx.us-east-2.aws.neon.tech/neondb?sslmode=require`

### 4. First Visit

- Vercel deployment completes → open your app URL
- See `/setup` page (auto-redirects if no users exist)
- Fill form: business name, colors, logo URL, admin account
- Submit → owner account created + session set
- Redirect to `/schedule` logged in as owner

## Key Implementation Details

### Database
- Uses `@neondatabase/serverless` with tagged template literals
- Schema auto-migrates on first request (CREATE TABLE IF NOT EXISTS)
- No external migration tools needed
- Supports all Postgres features including functions, indexes, constraints

### Authentication
- 32-byte hex session tokens stored in `sessions` table
- HTTP-only cookies with Secure + SameSite=Lax flags
- Argon2id password hashing (via `@node-rs/argon2`)
- 30-day session expiry
- Middleware checks session on every request

### Branding
- Single-row `app_branding` table stores customization
- Middleware loads branding on every request
- CSS custom properties `--brand-primary` and `--brand-accent`
- All colors inherit from these variables (no hardcoded colors)
- Customer edits via `/admin/branding` (owner only)

### Role-Based Access
- **Owner**: Everything (only one, created at setup)
- **Manager**: Schedule + users + request approval
- **Staff**: View own schedule, request time-off, swap shifts
- Middleware blocks unauthorized routes
- API endpoints check `Astro.locals.user` and return 401/403

### Forms & API
- All forms POST to `/api/*` endpoints
- Set-Cookie headers to manage sessions
- Redirects on success, JSON errors on failure
- All API routes check auth and role permissions

## Acceptance Checklist

- [x] `pnpm install && pnpm build` succeeds with no errors
- [x] Code ready to push to GitHub
- [x] Astro + Vercel adapter configured correctly
- [x] Neon Postgres schema ready (auto-creates on first request)
- [x] All routes implemented (setup, login, schedule, admin, API)
- [x] Branding system with dynamic CSS colors
- [x] Session authentication with Argon2
- [x] Role-based access control
- [x] README with Deploy to Vercel button
- [x] TypeScript strict mode throughout
- [x] Path aliases (@/*) working
- [x] No Docker, SQLite, or relative imports
- [x] One-click deployment ready

## Testing Locally

```bash
# Install (if not already done)
pnpm install

# Dev server
pnpm dev
# Opens at http://localhost:3000

# See /setup if no users exist
# Fill form, create admin account
# Now at /schedule logged in

# Create more users at /admin/users (admin only)
# Add shifts at /admin/schedule (admin only)
# View/swap shifts as staff
```

For local Postgres, you can use Docker or set POSTGRES_URL to a local database.

## Support

The code is fully documented and follows Astro best practices. Key resources:
- Astro docs: https://docs.astro.build
- Vercel adapter: https://docs.astro.build/en/guides/integrations-guide/vercel/
- Neon docs: https://neon.tech/docs
- Tailwind v4: https://tailwindcss.com/docs

---

The app is production-ready and waiting for GitHub + Vercel to go live!
