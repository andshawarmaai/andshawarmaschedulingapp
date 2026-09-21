# Chat Bot Action Block — Debug Handoff

## Problem
The chat bot at https://andshawarmaschedulingapp.vercel.app says it scheduled shifts but doesn't actually persist them. When a manager says "schedule Jorge next Friday 4pm to 1am", the bot replies:

> "Done. Jorge is on Friday September 25, 4pm to 1am."

But `/api/state` shows `jorge_shifts: 0`. The bot never wrote to the database.

## Root Cause
The chat bot is supposed to emit a fenced JSON action block BEFORE its confirmation sentence:

```
​```json
{"actions":[{"method":"POST","endpoint":"/api/shifts","body":{"user_id":"<id>","date":"2026-09-25","start_time":"16:00","end_time":"01:00"},"summary":"Jorge on Fri Sep 25, 4pm to 1am"}]}
​```
Done - Jorge is on Friday September 25, 4pm to 1am.
```

`scripts/hermes-bridge.mjs` parses the JSON block out of the reply and POSTs each action to the relevant `/api/*` route. Without the block, no action runs.

When the bot DOES emit the block (414-char reply), actions persist. When it skips it (50-77 char plain text), nothing happens. ~50% failure rate.

## Architecture
- **App**: Astro 5 + Vercel serverless. Source in `/Users/testuser/andshawarma-scheduling/`.
- **Chat orchestrator**: `src/pages/api/agent/chat/index.js` POST handler.
  - Reads state directly from `db` (not via self-fetch — that was fixed).
  - Builds a payload, POSTs to local tunnel URL via `callHermes()`.
  - `callHermes` has a 55s AbortController timeout (line 588).
  - Background work runs via `waitUntil` so HTTP response returns immediately.
- **Bridge**: `scripts/hermes-bridge.mjs` runs locally on port 7890.
  - Receives orchestrator's POST, spawns `hermes chat --oneshot -Q --query <prompt>`.
  - Parses ```json``` blocks from reply, returns `{content, actions}` to orchestrator.
  - `REQUEST_TIMEOUT_MS = 55_000` in the bridge, matching orchestrator.
- **Tunnel**: Cloudflare named tunnel `shawarma-bridge` (id `44210feb-...`) routing `https://andshawarmaschedule.com` → `http://localhost:7890`.
- **Bridge process**: Currently PID 94425 running as background process (no LaunchAgent — was being killed by the old LaunchAgent, see handoff section below).
- **Hermes binary**: `/Users/testuser/.local/bin/hermes` (uses MiniMax OAuth subscription).

## What's Already Been Done (Do Not Redo)
1. ✅ Built chat orchestrator with `waitUntil` for async work
2. ✅ Direct DB read instead of broken `/api/state` self-fetch
3. ✅ Cloudflare named tunnel + DNS CNAME for `andshawarmaschedule.com`
4. ✅ Replaced `POST` self-call with `GET` in the orchestrator's history fetch
5. ✅ Wrote new CHAT_BOT_PROMPT with 6 sections (identity / guidelines / guardrails / workflow / action-mandatory / examples / safety check)
6. ✅ Examples in the prompt now show the action block format
7. ✅ 12 users seeded into the DB, ray is admin

## Files Involved
- `scripts/hermes-bridge.mjs` — has the CHAT_BOT_PROMPT constant and the action parser
- `src/pages/api/agent/chat/index.js` — orchestrator
- `src/pages/api/agent/chat/index.js` line 588 — `setTimeout(() => controller.abort(), 55000)` in `callHermes`
- `src/lib/agentChat.js` — `chat` module wrapping DB CRUD
- `src/lib/db/index.js` / `neon.js` / `local.js` — DB layer
- `/Users/testuser/andshawarma-scheduling/db/roster.mjs` — canonical user list

## Diagnostic Checks Already Run
- `/api/state` from a logged-in browser session returns 12 users + 6 templates (verified)
- Bridge receives `payload.state.users = 12, payload.state.shiftTemplates = 6` (verified)
- Hermes reply length varies from 36–414 chars (some include action blocks, most don't)
- Tunnel health: `https://andshawarmaschedule.com/health` returns `ok` in 0.4s
- `export const maxDuration = 60` added to chat route — may or may not be honored on Hobby plan

## The Real Issue
The prompt instructions aren't strong enough to override Hermes's base-model behavior of just *describing* what it would do, rather than actually emitting the JSON action block.

## Try These Fixes (in order of likelihood to work)

### 1. Add a post-processing fallback in the bridge
If the bot replies with confirmation text but no action block, and the message clearly implies a schedule change (contains verbs like "schedule", "add", "put", "post"), retry Hermes once with a stronger prompt that says: "Your previous reply did not include a JSON action block. You MUST emit it now. Plain text alone does nothing."

In `scripts/hermes-bridge.mjs`:
- After `const reply = await callHermes(prompt)`, check if it contains a ```json``` block.
- If not AND the user's message contains action verbs AND the reply looks like a confirmation, retry with the same prompt plus an explicit reminder.

### 2. Patch the prompt with even stronger language
In `scripts/hermes-bridge.mjs`, find the `# 4b. MANDATORY ACTION BLOCK` section and:
- Add: "If you do not emit the block, your reply will be deleted and you will be asked to try again."
- Add: "The user CANNOT see your action block. It is hidden from them. Only your one-sentence confirmation is shown. So there is no risk in emitting it."
- Add: "Format reminder — three backticks, the word json on the same line, then the JSON object, then three backticks on a line by themselves. NOT markdown inline code."

### 3. Use a more verbose action block format the model knows
Some models have been trained on specific function-calling formats. Try:
```
[ACTION]
{"actions":[{"method":"POST","endpoint":"/api/shifts","body":{...},"summary":"..."}]}
[/ACTION]
```
And update the bridge parser to also recognize `[ACTION]...[/ACTION]`.

### 4. Switch from prompt-based action emission to OpenAI-style function calling
If Hermes supports function calling / tool use, define a `create_shift` tool with the schedule shape and have Hermes call it. The orchestrator then receives a structured tool call instead of needing to parse a JSON block. This is much more reliable than text-based JSON blocks.

### 5. Add a forced retry inside the orchestrator
In `src/pages/api/agent/chat/index.js`, after getting Hermes' reply:
- If `actions.length === 0` AND the user message looks like a schedule change, retry Hermes ONCE with: "Your previous reply acknowledged the action but did not emit the required JSON block. The user's request will not be performed unless you emit the block now."
- Bump the orchestrator's `setTimeout` to 90_000 since we'll do two calls.
- This is a "scorched earth" fallback that should catch the 50% miss rate.

## Other Known Issues To Not Reinvestigate
- The orchestrator used to POST to its own `/api/agent/chat` to get history — that was a self-call loop. **Fixed**: now does `method: 'GET'`.
- The orchestrator used to fetch `/api/state` for context — that was failing with "fetch failed" due to Vercel edge blocking self-calls. **Fixed**: now reads DB directly.
- `days_of_week` from DB might be a string `"1,2,3"` or array `["1","2","3"]` depending on backend. **Fixed** in the bridge with type coercion.
- Tunnel URL keeps rotating for quick tunnels. **Fixed**: now using named tunnel `shawarma-bridge` with permanent URL `https://andshawarmaschedule.com`.
- Bridge keeps respawning (LaunchAgent conflict). **Fix**: not done yet — currently running as a foreground background process. The cloudflared named tunnel + bridge + LaunchAgent setup needs to be cleaned up. The OLD `com.shawarma.hermes-bridge.plist` LaunchAgent was unloading the bridge every time we killed it. `launchctl bootout gui/$(id -u)/com.shawarma.hermes-bridge` then `launchctl load` will disable it. Or just delete the plist file.

## Test Commands

```bash
# Login as ray (triggers chat-clear, sets cookie)
curl -s -c /tmp/c.txt -X POST https://andshawarmaschedulingapp.vercel.app/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"ray","password":"ray"}'

# Send chat
API_KEY="shwrm_qzxsVhmGn8l0rU8a6EApj356JfubA_fc"
curl -s -X POST https://andshawarmaschedulingapp.vercel.app/api/agent/chat \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"content":"schedule Jorge next Friday 4pm to 1am"}'

# Wait 60-90s, then check history
curl -s https://andshawarmaschedulingapp.vercel.app/api/agent/chat \
  -H "Authorization: Bearer $API_KEY" | python3 -m json.tool

# Verify shifts in DB
curl -s -b /tmp/c.txt https://andshawarmaschedulingapp.vercel.app/api/state \
  | python3 -c "import sys, json; d=json.load(sys.stdin); users={u['username']:u for u in d['users']}; print([s for s in d['shifts'] if users[s['user_id']]['username']=='jorge'])"
```

## Environment
- macOS 26.6.2 on Rays-MacBook-Air
- Node.js 26.8.1
- User: Waqas Hassan (waqastheboss GitHub account, andshawarmaai for this repo)
- Repo: `andshawarmaai/andshawarmaschedulingapp` on GitHub
- Vercel project: `and-shawarma/andshawarmaschedulingapp` (Hobby plan — 10s default function timeout, Fluid Compute 300s with maxDuration export)
- Cloudflare account: `and-shawarma` (account id `6e1f64193382431c47a903277342e86c`)
- Tunnel ID: `44210feb-6904-4456-bdd6-1197a1e63d66`
- Domain: `andshawarmaschedule.com` (zone id `76b74e6b4f5f3e30e6bf40d155691e1e`)

## Critical Files To Read First
1. `/Users/testuser/andshawarma-scheduling/scripts/hermes-bridge.mjs` — lines 32-117 (the CHAT_BOT_PROMPT)
2. `/Users/testuser/andshawarma-scheduling/src/pages/api/agent/chat/index.js` — the orchestrator, esp. lines 580-600 (callHermes) and 360-380 (orchestrateReply state fetch)
3. `/Users/testuser/andshawarma-scheduling/CHAT_BOT.md` and `/Users/testuser/andshawarma-scheduling/CHATBOT-TRAINING.md` (the user's notes on training requirements)

The user has already approved committing and pushing to GitHub. Don't ask permission to deploy — just do it.
