# Chat Bot — Status Report for Claude (2026-09-21)

## TL;DR
Your MCP architecture is in place — MCP server runs, config has `enabled: true`, `hermes mcp test shawarma` lists all 10 tools. **But the live chat still isn't working**. Latest scheduling test (`schedule Jorge next Friday 4pm to 1am`) hung for 10+ minutes, then failed with `Error: This operation was aborted`. Zero shifts in DB.

## What's been wired up (all verified)

### MCP server
- `scripts/mcp-server.mjs` exists, reads `AGENT_API_KEY` + `VERCEL_BASE` from env
- Configured in `~/.hermes/profiles/scheduling/config.yaml` under `mcp_servers.shawarma` with `enabled: true` and `env: { AGENT_API_KEY, VERCEL_BASE }` as a separate YAML key (NOT inside args — that was a fix I made, see "Config bug fix" below)
- `hermes mcp test shawarma` returns the full 10-tool list ✓

### Bridge
- `scripts/hermes-bridge.mjs` is running PID 29184 with these env vars set:
  - `HERMES_MCP_TOOLSET=mcp-shawarma`
  - `AGENT_API_KEY=shwrm_xzxsVhmGn8l0rU8a6EApj356JfubA_fc`
- Bridge passes `-t mcp-shawarma` to `hermes chat` when the env var is set

### Vercel
- Latest build deployed includes commit `29c7b12`'s MCP-aware orchestrator changes
- `mcp_executed` flag plumbed through

## Config bug fix I made (Hermes may not realize)

The initial `hermes mcp add` CLI wrote malformed YAML. It stored env vars as PART OF the args array:
```yaml
args:
  - /Users/testuser/andshawarma-scheduling/scripts/mcp-server.mjs
  - --env                                       # ← this becomes an arg to node, not a hermes flag
  - AGENT_API_KEY=shwrm_xxx
  - --env
  - VERCEL_BASE=https://...
```
So `node` got `--env AGENT_API_KEY=...` as unknown flags and the server bailed ("AGENT_API_KEY is not set") without hermes ever seeing the failure clearly.

I fixed it manually by replacing with:
```yaml
mcp_servers:
  shawarma:
    command: node
    args:
      - /Users/testuser/andshawarma-scheduling/scripts/mcp-server.mjs
    env:
      AGENT_API_KEY: shwrm_xzxsVhmGn8l0rU8a6EApj356JfubA_fc
      VERCEL_BASE: https://andshawarmaschedulingapp.vercel.app
    enabled: true
```
After this, `hermes mcp test shawarma` succeeds. So the config syntax fix is correct.

## Test results — what's failing

### Test 1: `hermes mcp test shawarma` → ✅ all 10 tools listed

### Test 2: `hermes chat --oneshot --toolsets "mcp-shawarma" --query "list 3 users using the state_read tool"`
**Status: in progress / timed out** (started at proc_55cf6f6b0d86, hasn't returned as of this handoff write). The single-shot invocation of hermes with the toolset enabled is hanging. Either hermes is taking 1+ minutes to cold-start with MCP enabled, or the MCP server is breaking the spawn path somehow.

### Test 3: Live chat via Vercel + tunnel → ❌ HTTP 504 / aborted
Sent "schedule Jorge next Friday 4pm to 1am" via API. Status stayed `pending` for 10 minutes. Final reply:
```
[assistant] error
Hermes wasn't reachable at https://andshawarmaschedule.com. Make sure your Mac is on and the bridge is running.
Error: This operation was aborted
```

The "This operation was aborted" matches the AbortController's 55s timeout in `callHermes()` (orchestrator line ~588). So either:
- The bridge was already hung from a previous request when this one fired (queueing)
- Or hermes is taking >>55s to respond now that MCP is enabled (likely — MCP server spawn cost + tool discovery on first call)

## Still-unknown: does hermes even see the MCP server when launched via the bridge?

The bridge spawns `hermes chat --oneshot -Q --query <prompt> -t mcp-shawarma`. We've never confirmed:
1. Does hermes start the MCP subprocess at all?
2. Does it pass the env vars through?
3. Does hermes use the MCP tools in its reply, or ignore them?

## What Claude Should Try Next

### 1. Diagnose MCP discovery — add stderr capture to the bridge
Currently `hermes chat` output goes to a pipe and is discarded. Modify `scripts/hermes-bridge.mjs`'s `callHermes()` to capture stderr and log it:
```js
const proc = spawn(HERMES_BIN, args, {
  stdio: ['ignore', 'pipe', 'pipe'],   // already piping stderr
  env: { ...process.env, HERMES_PROFILE: ..., HERMES_MCP_TOOLSET: ... },
});
proc.stderr.on('data', (d) => console.error('[hermes stderr]', d.toString('utf8')));
```
That'll show whether hermes is even attempting to connect to `shawarma` MCP.

### 2. Also pass HERMES profile settings via env
`HERMES_MCP_TOOLSET` may not be enough — hermes might want `HERMES_MCP_CONFIG_PATH` or similar. Grep the hermes-agent source for the env var that actually triggers toolset loading.

### 3. Test the MCP server end-to-end from a plain `hermes chat` session
The `hermes mcp test` only verifies discovery, not tool invocation. Run:
```bash
hermes chat --oneshot --toolsets "mcp-shawarma" --query "list 3 users using state_read"
```
Already in flight — see if it returns or hangs. If it hangs, the MCP server itself is broken when hermes invokes it. If it returns but no shift persists, the orchestrator isn't executing MCP-returned actions.

### 4. If MCP server is the bottleneck, make it HTTP instead of stdio
The simpler transport. Serve MCP over an HTTP endpoint on `127.0.0.1:7891`, register with `hermes mcp add --url http://localhost:7891/mcp`, and use cookie auth via the existing bridge pipe. Loses stdio elegance but is much easier to debug (curl, logs, browser tools).

### 5. Check the timestamp on the commits you pushed
Handoff doc says commit `29c7b12` was pushed at `15:42:17` UTC. Latest orchestrator code on `origin/main` should have `mcp_executed: true` handling. If that handling is wrong (e.g. treats `mcp_executed: true` as an error), it'd explain "operation aborted."

## Files to look at
- `/Users/testuser/andshawarma-scheduling/scripts/mcp-server.mjs` — server (your code, looks fine)
- `/Users/testuser/andshawarma-scheduling/scripts/hermes-bridge.mjs` — the spawn logic, esp. `callHermes()` and the env handling
- `/Users/testuser/andshawarma-scheduling/src/pages/api/agent/chat/index.js` — orchestrator
- `/Users/testuser/.hermes/profiles/scheduling/config.yaml` — line 172+ has the mcp_servers block

## Environment
- macOS 26.6.2 (M-series)
- Node.js 26.8.1 + Node.js 22 (hermes binary uses this)
- `hermes` CLI at `/Users/testuser/.local/bin/hermes` (uses MiniMax OAuth subscription)
- Cloudflare named tunnel `shawarma-bridge` routing `andshawarmaschedule.com` → `127.0.0.1:7890`
- Bridge PID 29184 on port 7890
- cloudflared PID 2787 running the named tunnel
- Vercel Hobby plan (function timeout 60s default, Fluid Compute gives 300s)
- Tunnel + health verified: `https://andshawarmaschedule.com/health` → `ok` in <500ms

## Test that gets the chat working end-to-end
Once the bridge knows hermes is using the MCP toolset:
```bash
# Login + clear chat
curl -s -c /tmp/c.txt -X POST https://andshawarmaschedulingapp.vercel.app/api/auth/login \
  -H "Content-Type: application/json" -d '{"username":"ray","password":"ray"}'

# Send a chat
API_KEY="shwrm_qzxsVhmGn8l0rU8a6EApj356JfubA_fc"
SENT_ID=$(curl -s -X POST https://andshawarmaschedulingapp.vercel.app/api/agent/chat \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"content":"schedule Jorge next Friday 4pm to 1am"}' \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['message']['id'])")

# Watch for ~3 min
for i in {1..90}; do
  sleep 2
  STATUS=$(curl -s "https://andshawarmaschedulingapp.vercel.app/api/agent/chat" \
    -H "Authorization: Bearer $API_KEY" | python3 -c "
import sys, json
data = json.load(sys.stdin)
msgs = [m for m in data.get('history', []) if m.get('parent_id') == '$SENT_ID']
if msgs:
    m = msgs[-1]
    print(f'{m[\"status\"]}|actions={len(m.get(\"actions\", []))}|{m[\"content\"][:200]}')
else: print('pending|0|')")
  STATE=$(echo "$STATUS" | cut -d'|' -f1)
  echo "  t=$((i*2))s $STATUS"
  [[ "$STATE" == "complete" || "$STATE" == "error" ]] && break
done

# Verify
curl -s -b /tmp/c.txt https://andshawarmaschedulingapp.vercel.app/api/state \
  | python3 -c "
import sys, json
d = json.load(sys.stdin)
users = {u['username']: u for u in d['users']}
jorge = [s for s in d['shifts'] if users[s['user_id']]['username'] == 'jorge']
print(f'jorge shifts: {len(jorge)}')
for s in jorge: print(f'  {s[\"date\"]} {s[\"start_time\"]}-{s[\"end_time\"]}')"
```

If jorge shifts > 0: MCP works. If still 0: the tool call isn't reaching the server, or the orchestrator isn't extracting the result.
