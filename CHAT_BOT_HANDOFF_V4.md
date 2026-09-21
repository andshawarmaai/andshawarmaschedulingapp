# Chat Bot — Architecture Change for Hermes (2026-09-21, from Claude)

## TL;DR

The owner decided the fenced-JSON-block approach isn't salvageable (it measured a ~50% miss rate in your own testing, and no amount of stronger prompting fixed it — nothing forces the model to include it). We also confirmed the owner cannot use the MiniMax Token Plan / Subscription Key as a pay-as-you-go API key from a hosted backend — that's explicitly not what it's for (MiniMax's own docs: "Subscription Key is not interchangeable with pay-as-you-go API Keys"). So the fix has to keep running through you, on the Mac, using the subscription the normal way — just make it structurally reliable instead of prompt-reliant.

**The fix: a real MCP server.** Pushed to `main` at commit `29c7b12`. `scripts/mcp-server.mjs` exposes this app's own API as proper MCP tools — Hermes calls them the same structured way it calls its built-in tools (bash, file edit, etc.), with arguments schema-validated before this app's API ever sees them. No JSON block, no regex parsing, no "did the model remember."

**This needs your help to finish** — specifically confirming the exact `hermes mcp add` / `hermes mcp list` / `-t`/`--toolsets` syntax against your actual installed CLI, since I could not run `hermes` myself to verify (no Mac access from my sandbox). Everything below is written so you can just follow it directly — the owner doesn't need to relay anything technical back and forth.

## What changed, concretely

### 1. New file: `scripts/mcp-server.mjs`

A standard MCP server (uses `@modelcontextprotocol/sdk`, now a project dependency — `npm install` will pull it). Runs over stdio (Hermes spawns it as a child process — no port, no separate tunnel). Exposes 10 tools, built directly from `src/lib/agentGuide/registry.js` (the same file `AGENT-TRAINING.md` is generated from, so the shapes match exactly what the app's routes actually expect):

- `state_read` — read users/shifts/templates/etc.
- `shift_create`, `shift_update`, `shift_delete`
- `availability_create`, `availability_cancel`
- `timeoff_create`, `timeoff_cancel`
- `swap_post_create`, `swap_claim_create`

Each tool handler calls this app's real `/api/*` routes with `Authorization: Bearer <AGENT_API_KEY>` — same key you already use, same attribution model (CLAUDE.md §6: a write is attributed to whoever created the key, exactly as if they'd clicked it in the app).

I verified it locally with a throwaway MCP test client (`Client` + `StdioClientTransport` from the same SDK) — it starts cleanly and correctly advertises all 10 tools with valid schemas. I could not test an actual live API call end-to-end (no real API key in my sandbox), so **please do one real smoke test** (see "Verify" below) before trusting it fully.

### 2. `scripts/hermes-bridge.mjs` changes

- New env var: `HERMES_MCP_TOOLSET`. When set, the bridge passes `-t <value>` to `hermes chat` so the toolset is available for that call.
- The old `# 4b. MANDATORY ACTION BLOCK` prompt section (the "you must emit a fenced JSON block" instructions + the JSON-heavy few-shot examples) is **gone** from the main prompt — real tool use doesn't need prompted formatting, and leaving contradictory instructions in would confuse the model.
- That old approach is kept ONLY as `LEGACY_ACTION_BLOCK_INSTRUCTIONS`, appended to the prompt **only when `HERMES_MCP_TOOLSET` is unset** — so a session still limps along in degraded mode if the MCP toolset isn't registered yet. Not meant to be the long-term path.
- The response now includes `mcp_executed: true` whenever the toolset was enabled for that call — see next section for why this matters.

### 3. `src/pages/api/agent/chat/index.js` changes

The orchestrator used to do two things after getting Hermes's reply: (a) retry once if no action block was found and the message implied one, (b) execute any parsed actions itself via this app's own API. **Both of those are now wrong once MCP is doing the work** — Hermes has already executed the real action directly. So:

- It now checks `mcp_executed` and **skips the retry** when true (an empty `actions[]` from a fully-MCP-handled turn is correct and expected, not a sign anything failed).
- Since `mcp_executed` turns naturally return `actions: []` from the bridge, the orchestrator's execute-loop has nothing to do for them — which is correct, avoiding a double-write of the same shift. **Don't change this without understanding why** — if you ever see `actions` populated alongside `mcp_executed: true`, something upstream is wrong; that combination should never happen.

## What YOU need to do (in order)

### Step 1 — Pull and build

```bash
cd /Users/testuser/andshawarma-scheduling
git status                              # check for local divergence first — see the note below
git fetch origin main
git reset --hard origin/main            # discard local divergence; origin is the source of truth
npm install                             # pulls in @modelcontextprotocol/sdk + zod
npm run build                           # should complete clean
```

**Why `reset --hard` and not just `pull`:** a previous session found your local Mac checkout had diverged from `origin/main` (a merge commit referencing `git checkout --theirs` that doesn't exist on GitHub at all) and that divergence was almost certainly what got deployed, causing a fix that looked "missing" even though it was correctly on `origin/main` the whole time. Starting from a clean `reset --hard` avoids repeating that.

### Step 2 — Register the MCP server with Hermes

```bash
hermes mcp add shawarma --command "node /Users/testuser/andshawarma-scheduling/scripts/mcp-server.mjs"
```

**I could not verify this exact command against your installed CLI** — I only have Hermes Agent's public docs to go on, and pieced this together from `hermes mcp add <name> --command CMD` in the CLI reference. Please run `hermes mcp add --help` first to confirm the flag name and syntax before running it for real, and note whether it needs the `AGENT_API_KEY` env var passed some other way (the server reads it from its own process environment — you may need `hermes mcp add` to support an `--env` flag, or you may need to export `AGENT_API_KEY` in the shell that starts Hermes/the bridge, whichever the CLI actually supports).

Then check what toolset name it was actually registered under:

```bash
hermes mcp list
```

It may be exactly `shawarma`, or `mcp-shawarma`, or something else — **use whatever `hermes mcp list` actually shows you**, not my guess.

### Step 3 — Set the toolset name for the bridge

Whatever `hermes mcp list` showed, set it when starting the bridge:

```bash
export AGENT_API_KEY="shwrm_xxxxxxxxxxxxxxxxxxxxxxxx"   # the real key, not the hardcoded one in the bridge — see the note below
export HERMES_MCP_TOOLSET="shawarma"                     # or whatever `hermes mcp list` actually showed
cd /Users/testuser/andshawarma-scheduling
node scripts/hermes-bridge.mjs &
```

**Also flagging again since it's still unfixed:** `hermes-bridge.mjs` has a real API key hardcoded as a fallback default (`shwrm_qzxsVhmGn8l0rU8a6EApj356JfubA_fc`) — a secret committed to source control. Please revoke that key in Manage → API Keys and create a fresh one, set only via the `AGENT_API_KEY` env var going forward, never hardcoded. I didn't remove the fallback line myself since I don't want to accidentally break your running setup without you present to immediately regenerate a working key — your call on timing, but it should happen.

### Step 4 — Deploy

```bash
cd /Users/testuser/andshawarma-scheduling
/Users/testuser/.local/node_modules/.bin/vercel deploy --prod --yes --token "$VERCEL_TOKEN"
```

### Step 5 — Verify (the real test)

```bash
# Login
curl -s -c /tmp/c.txt -X POST https://andshawarmaschedulingapp.vercel.app/api/auth/login \
  -H "Content-Type: application/json" -d '{"username":"ray","password":"ray"}'

# Send a real scheduling message
API_KEY="shwrm_xxxxxxxxxxxxxxxxxxxxxxxx"   # your real key
curl -s -X POST https://andshawarmaschedulingapp.vercel.app/api/agent/chat \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  -d '{"content":"schedule Jorge next Friday 4pm to 1am"}'

# Wait ~30-60s, then check the actual database
curl -s -b /tmp/c.txt https://andshawarmaschedulingapp.vercel.app/api/state \
  | python3 -c "
import sys, json
d = json.load(sys.stdin)
users = {u['username']: u for u in d['users']}
jorge = [s for s in d['shifts'] if users.get(s['user_id'], {}).get('username') == 'jorge']
print(f'jorge shifts: {len(jorge)}')
for s in jorge: print(f'  {s[\"date\"]} {s[\"start_time\"]}-{s[\"end_time\"]}')"
```

Success looks like: `jorge shifts: 1` with the correct date/time, on the **first try**, no retry needed. If it's still 0, check (in order): is `mcp add` actually working (`hermes mcp list` shows it, `hermes chat -t <toolset> -z "what tools do you have"` mentions the scheduling ones)? Is `AGENT_API_KEY` actually set in the bridge's environment? Did the bridge log show `-t <toolset>` in its spawn args?

## Also worth doing once this works

Test the "every Saturday this month" case that broke before (`CHAT_BOT_DIAGNOSTIC_FOR_CLAUDE.md`) — with real tool calls now, this should produce one shift per matching Saturday, at the requested time, not one invented shift. The date-grounding fix (`TODAY'S DATE` line in the prompt) is still in place and should help here too.

## Files touched this round
- `scripts/mcp-server.mjs` — new
- `scripts/hermes-bridge.mjs` — toolset wiring, prompt simplified, `mcp_executed` flag
- `src/pages/api/agent/chat/index.js` — honors `mcp_executed`
- `package.json` / `package-lock.json` — added `@modelcontextprotocol/sdk`, `zod`
