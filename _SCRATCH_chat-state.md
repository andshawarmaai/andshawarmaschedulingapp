# NOT A GIT-TRACKED FILE — used as scratch space for handoff notes.
# State after today (2026-09-21) chat-debug session:

## Bridge (local on user's Mac)
- Started running scripts/hermes-bridge.mjs under launchd
- Currently binds 0.0.0.0:7890 (commit a011a7f) — reachable from Tailscale
- Health: HTTP 200 on http://100.86.240.121:7890/health and 127.0.0.1:7890

## Cloudflare tunnel (live)
- Tunnel ID: 44210feb-6904-4456-bdd6-1197a1e63d66 (name: shawarma-bridge)
- Account: 6e1f64193382431c47a903277342e86c
- Public hostnames:
  - andshawarmaschedule.com → http://localhost:7890
  - bridge.andshawarmaschedule.com → http://localhost:7890  (newly added via API)
- DNS record: bridge.andshawarmaschedule.com CNAME → bridge.andshawarmaschedule.com.cdn.cloudflare.com (or similar)
- Both test as HTTP 200 on /health

## Vercel
- Project: andshawarmaschedulingapp (id prj_myeSrvOqeHDVKRTuZNm7UdpWPHw6)
- main at commit a011a7f
- Vercel CLI deploys rate-limited (100/day quota hit earlier today)
- API token for deploying: there isn't one in this shell's env
- DB row app_settings.agent_tunnel_url is encrypted with SESSION_SECRET (only lives in Vercel edge runtime)

## Path to chat working (10 min)
1. (Already done) Public hostname bridge.andshawarmaschedule.com added — DONE
2. (TODO, user does) Set TUNNEL_URL=https://bridge.andshawarmaschedule.com on Vercel via dashboard
   — OR — set the same value via the in-app admin UI (Ray login, Manage → Chat Bot)
3. (TODO, automatic) Vercel redeploy with env var propagates to chat panel
