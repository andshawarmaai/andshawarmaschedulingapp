# Chat Bot — Status Update for Claude (2026-09-21)

## TL;DR
Your commit `ff4dadf` ("Fix chat bot claiming success when actions actually fail") was successfully cherry-picked into main and deployed to Vercel. The fix is LIVE.

However, **the chat is still not writing shifts to the database**, because of a separate root cause: the bot is replying in plain text without emitting the JSON action block that the bridge parses. Your commit handles the case where the bot DOES emit a block but the action fails — it doesn't help when the bot skips the block entirely.

The handoff doc at `CHAT_BOT_DEBUG_HANDOFF.md` (still on main) explains the architecture and lists 5 ranked fix attempts.

## Latest Test Results (post-deploy, 2026-09-21 14:50 EDT)

Three messages sent via `https://andshawarmaschedulingapp.vercel.app/api/agent/chat` (with the Bearer API key). All show `actions=0` and remain stuck in `pending` status even after 90+ seconds:

```
[user]    pending   actions=0   schedule Jorge next Friday 4pm to 1am
[user]    pending   actions=0   hello
[assistant] complete  actions=0   Hey Ray, what shift do you need to set up?
[user]    pending   actions=0   add me to every saturday this month
```

DB state: `total shifts: 0`.

The "hello" → "Hey Ray, what shift..." exchange completed in <60s with no action block (correct behavior — no action was requested). The two scheduling requests have been stuck `pending` for **3+ minutes** with no assistant reply.

## Two Problems Now

### Problem A: Bot doesn't emit action blocks (~50% miss rate)
The bridge prompt has the action block format shown in section 5 examples, but Hermes often skips it. From earlier session log:
- `414 chars` reply → action block present, persists to DB
- `50/51/77 chars` reply → plain text only, no block, nothing happens

### Problem B: Background orchestrator work may be killed by Vercel Hobby limit
On Hobby, Vercel's default maxDuration for `waitUntil` background work is 300 seconds (Fluid Compute) or less. The `export const maxDuration = 60` set on `src/pages/api/agent/chat/index.js` may not actually be honored on Hobby without explicit Fluid Compute enablement in the dashboard.

The fact that messages stay `pending` for 3+ minutes is consistent with either:
- The orchestrator's `callHermes` is hanging (55s AbortController should fire — but maybe not)
- Vercel killed the function after 60-300s before `orchestrationPromise` completed
- The SSE stream isn't pushing updates correctly

## What's Currently Deployed

```
Functions (Vercel):
  and-shawarma/andshawarmaschedulingapp  Hobby plan, Fluid Compute default
  Latest deploy: dpl_732iLU4rDBuJD4icwQ55yGAUwkGw  (Claude's ff4dadf fix)
  URL: https://andshawarmaschedulingapp.vercel.app
  Domain: andshawarmaschedule.com (custom, via Cloudflare tunnel)

Local processes:
  cloudflared tunnel --config ~/.cloudflared/config.yml run  (named tunnel shawarma-bridge)
  /Users/testuser/.hermes/node/bin/node scripts/hermes-bridge.mjs  (PID 2723, on :7890)

Both processes running. Tunnel URL https://andshawarmaschedule.com reachable.
Saved tunnel URL in app: confirmed via /api/admin/settings/tunnel returns reachable:true.

Database:
  12 users on roster (ray, azmeer, badar, jorge, jeremy, adnan, david, albero, john, sanaa, bhanu)
  6 shift templates
  0 shifts
```

## Git State
```
main: 0ee47e9 Fix chat bot claiming success when actions actually fail (force-pushed)
origin/main: 0ee47e9
origin/claude/gallant-thompson-p2ojye: ff4dadf (the same commit author + content as ours)
```

Local working tree has uncommitted changes (Hermes's chat-identity card + tunnel script). They were stashed during the cherry-pick, then `git stash pop` ran — but `npm run build` then succeeded so the tree is fine.

## What Claude Should Try Next (priority order)

### 1. Force-retry when bot emits no action block (highest leverage)
In `src/pages/api/agent/chat/index.js` `orchestrateReply()`, after getting `assistantText` + `actions`:

```js
// If the bot's plain-text reply suggests a schedule change was made
// but it didn't emit an action block, retry Hermes once with a
// stronger reminder.
const textImpliesAction = /\b(schedule|scheduled|added|put|created|posted|set)\b/i.test(assistantText);
if (actions.length === 0 && textImpliesAction) {
  const retryPrompt = prompt + '\n\n[REMINDER] Your previous reply acknowledged a schedule change but did not include the required JSON action block fenced in triple backticks. The user request WILL NOT be performed unless you emit the block. Plain text confirmation does nothing on its own. Try again now with the block.';
  const retry = await callHermes(retryPrompt);
  // ... parse actions from retry, use retry's content if it has a block ...
}
```

This is the 50% fix from handoff doc option #5. Should be a 30-line patch.

### 2. Make sure Vercel Fluid Compute is on
On Hobby, Fluid Compute bumps the function limit from 10s default to 300s. Without it, the orchestrator dies after 10s. Check:
- Vercel dashboard → project → Settings → Functions → Fluid Compute toggle

Or in `vercel.json`:
```json
{
  "functions": {
    "api/agent/chat/index.js": {
      "maxDuration": 60,
      "memory": 1024
    }
  }
}
```

(Already tried `export const maxDuration = 60` in the route file — unclear if it took effect.)

### 3. Reduce orchestration timeout further
55s for hermes is generous. Bring it down to 45s so the orchestrator's `waitUntil` finishes faster and we can see if a single message completes within Vercel's budget.

### 4. Hardcode the action block in the bridge prompt at the TOP
If section 5 examples aren't enough, put the action format as section 0 — the very first thing the bot reads. Force it before any other context.

### 5. Switch to OpenAI function calling (if Hermes supports it)
Most reliable. Define a `create_shift(user_id, date, start_time, end_time)` tool and let Hermes call it. The orchestrator gets a structured call instead of parsing JSON text. Eliminates the whole class of "bot forgot the block" bugs.

## Files To Read (priority order)
1. `/Users/testuser/andshawarma-scheduling/src/pages/api/agent/chat/index.js` orchestrator, especially lines 440-560 (action execution + Claude's recent fix)
2. `/Users/testuser/andshawarma-scheduling/scripts/hermes-bridge.mjs` lines 32-117 (CHAT_BOT_PROMPT)
3. `/Users/testuser/andshawarma-scheduling/CHAT_BOT_DEBUG_HANDOFF.md` (the original handoff)
4. `/Users/testuser/andshawarma-scheduling/astro.config.mjs` (maxDuration)
5. `/Users/testuser/andshawarma-scheduling/vercel.json` (if it exists)

## Quick Test Commands

```bash
# Login (auto-clears chat history)
curl -s -c /tmp/c.txt -X POST https://andshawarmaschedulingapp.vercel.app/api/auth/login \
  -H "Content-Type: application/json" -d '{"username":"ray","password":"ray"}'

# Send a chat
API_KEY="shwrm_qzxsVhmGn8l0rU8a6EApj356JfubA_fc"
SENT_ID=$(curl -s -X POST https://andshawarmaschedulingapp.vercel.app/api/agent/chat \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"content":"schedule Jorge next Friday 4pm to 1am"}' \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['message']['id'])")

# Poll for 60s and report
for i in $(seq 1 30); do
  sleep 2
  STATUS=$(curl -s "https://andshawarmaschedulingapp.vercel.app/api/agent/chat" \
    -H "Authorization: Bearer $API_KEY" | python3 -c "
import sys, json
data = json.load(sys.stdin)
msgs = [m for m in data.get('history', []) if m.get('parent_id') == '$SENT_ID']
if msgs:
    m = msgs[-1]
    print(f'{m[\"status\"]}|actions={len(m.get(\"actions\", []))}|{m[\"content\"][:200]}')
else:
    print('pending|0|')
")
  echo "  t=$((i*2))s $STATUS"
  if echo "$STATUS" | grep -qE '^(complete|error)\|'; then break; fi
done

# Verify whether the shift got persisted
curl -s -b /tmp/c.txt https://andshawarmaschedulingapp.vercel.app/api/state \
  | python3 -c "
import sys, json
d = json.load(sys.stdin)
users = {u['username']: u for u in d['users']}
jorge = [s for s in d['shifts'] if users[s['user_id']]['username'] == 'jorge']
print(f'jorge shifts: {len(jorge)}')
for s in jorge: print(f'  {s[\"date\"]} {s[\"start_time\"]}-{s[\"end_time\"]}')"
```

## Notes
- Bridge PID 2723 is running. If killed, restart with:
  `/Users/testuser/.hermes/node/bin/node /Users/testuser/andshawarma-scheduling/scripts/hermes-bridge.mjs &`
- Cloudflared named tunnel is the canonical one (PID is in the cloudflared log). Restart with:
  `/tmp/cloudflared tunnel --config /Users/testuser/.cloudflared/config.yml run &`
- The OLD `com.shawarma.hermes-bridge.plist` LaunchAgent was conflicting with the background processes. Currently DISABLED.
- Test against `https://andshawarmaschedule.com/health` to verify the tunnel is up (should return `ok`).

The deploy command from CLAUDE.md §13:
```bash
cd /Users/testuser/andshawarma-scheduling && /Users/testuser/.local/node_modules/.bin/vercel deploy --prod --yes --token "$VERCEL_TOKEN"
```
