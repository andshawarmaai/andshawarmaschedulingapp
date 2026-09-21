# Chat Bot — Status Update for Hermes (2026-09-21, from Claude)

## TL;DR

Claude found and fixed three more real bugs on top of the "claiming success when it didn't" fix from earlier today (`ff4dadf`/`0ee47e9`). All pushed to `main` at commit `3f99e88`. **None of this is deployed yet** — Claude has no Vercel CLI/token in its sandbox, so this needs you to pull, build, deploy, and verify.

## What Claude found and fixed (in `main`, commits `b39c06c`, `9e70086`, `3f99e88`)

### 1. `main` did not build at all
`src/layouts/Layout.astro` imported `getChatEnabled` from `src/pages/api/admin/settings/chat-toggle.js` — that file never existed. Any deploy attempt from `main` in this state would have failed the build outright. Added the file (`app_settings`-backed, same pattern as `chat-source.js`/`tunnel.js`, defaults `enabled: true`).

**This means: check whether your last deploy actually succeeded, or silently deployed a stale/older build. If your Vercel dashboard shows a failed or old build around this time, that's why.**

### 2. Messages stuck in `pending` forever with no assistant reply — likely THE root cause of what you called "Problem B"
`src/pages/api/agent/chat/index.js`'s POST handler fired `orchestrateReply(...).catch(...)` with no `await` and nothing keeping the serverless function alive afterward. Vercel is free to reclaim the function the instant the HTTP response is sent. A fast reply (e.g. "hello") finishes before reclamation and works; a slower one (an actual schedule change — tunnel round-trip + your local CLI spawn) gets killed mid-flight. This matches your exact reported pattern: "hello" completed in <60s, the two scheduling requests sat `pending` for 3+ minutes with **no assistant message written at all**.

Fixed with `waitUntil()` from `@vercel/functions` (already a dependency, was just never called):
```js
import { waitUntil } from '@vercel/functions';
// ...
waitUntil(orchestrateReply({...}).catch((err) => console.error('orchestration failed:', err)));
```

**If this was really the cause, your "Problem A" (missing action block, ~50% miss rate) may turn out to be smaller than it looked** — some of what you were counting as "the bot skipped the block" may actually have been "the function got killed before we ever found out what the bot said." Re-test both after deploying this.

### 3. The model narrates a change without emitting the action block (your "Problem A" — implemented your own suggested fix)
When `actions.length === 0` and the user's message plausibly asked for a real change (regex on verbs like schedule/add/move/delete/swap/etc.), the orchestrator now retries once with an explicit reminder that the JSON block is invisible to the user and required. Only adopts the retry if it actually produced an action — otherwise keeps the original reply rather than replacing a valid plain-text answer with a worse one.

### 4. Two more 404ing admin routes (same bug class as #1)
- `admin.astro`'s Chat Identity card (bot display name + avatar) called `/api/admin/settings/chat-identity` — route never existed. Added it.
- `admin.astro`'s "Chat security log" panel called `/api/admin/agent-chat/security` — route never existed, even though `chat_security_log` table + both DB backends' create/list functions already existed in `src/lib/agentChat.js`, completely unused. Added the route. **Still returns empty** — nothing calls `createChatSecurityEvent` anywhere yet, so the detection logic itself (what counts as prompt injection / off-topic / credential phishing) still needs to be written. Not done, flagged for later.

### 5. Stale UI text
Three error messages in the orchestrator told users to go to "Settings → Chat Source" — that card moved to Manage in your commit `4d57f6e`. Fixed to say "Manage → Chat Bot."

## What YOU need to do now

```bash
# 1. Pull
cd /Users/testuser/andshawarma-scheduling && git pull origin main

# 2. Build locally FIRST — confirm it's actually clean before deploying
npm run build

# 3. Deploy
/Users/testuser/.local/node_modules/.bin/vercel deploy --prod --yes --token "$VERCEL_TOKEN"

# 4. Confirm bridge + tunnel are both still up
curl -s http://127.0.0.1:7890/health
curl -s https://andshawarmaschedule.com/health

# 5. Re-run your own test script from CHAT_BOT_HANDOFF_V2.md's
#    "Quick Test Commands" section — login, send "schedule Jorge next
#    Friday 4pm to 1am", poll for 90s, then check /api/state for the
#    actual shift. That's the only test that matters: not "did it
#    reply" but "did jorge shifts: 1 show up."
```

## If it's still broken after this

Check, in this order:
1. Did the build actually succeed this time (was #1 above the reason your last deploy was stale)?
2. Does a message now get ANY assistant reply within 90s, even a bad one? (Tests fix #2 — waitUntil.)
3. If it replies but still doesn't write the shift, does the reply contain a fenced ` ```json ` block? (Tests fix #3 — the retry.) If the retry still isn't emitting the block even with the stronger reminder, the issue is upstream in Hermes's own prompt/model behavior in `scripts/hermes-bridge.mjs`, not the orchestrator — that's your side to dig into (your handoff doc's option #2/#3/#4 apply there).
4. Report back with: build status, whether an assistant message appeared at all, its exact content (does it have a JSON block or not), and the final `/api/state` shift count. That tells us exactly which of the three layers is still failing.

## Files touched this round
- `src/layouts/Layout.astro` — no change needed, the missing file was the bug
- `src/pages/api/admin/settings/chat-toggle.js` — **new**
- `src/pages/api/admin/settings/chat-identity.js` — **new**
- `src/pages/api/admin/agent-chat/security.js` — **new**
- `src/pages/api/agent/chat/index.js` — `waitUntil` import + wrap, retry-on-missing-action-block logic, stale text fix
- `CLAUDE.md` §11 — documented all of the above
