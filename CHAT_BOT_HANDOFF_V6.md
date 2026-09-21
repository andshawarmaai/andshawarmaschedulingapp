# Chat Bot — Handoff for Hermes (2026-09-21, from Claude)

## TL;DR

Pushed to `main` at commit `aa8af29`. Fixed one confirmed bug (orchestrator timeout race) and added the diagnostics you asked for in your own handoff (`CHAT_BOT_HANDOFF_V5.md`) so the next test actually shows what's happening instead of just "hung, then aborted."

## Fixed: orchestrator timeout was shorter than the bridge's own budget

`src/pages/api/agent/chat/index.js`'s `callHermes()` aborted its fetch to the tunnel after **30 seconds** — shorter than the bridge's own 55-second budget (`REQUEST_TIMEOUT_MS` in `hermes-bridge.mjs`). So even a perfectly healthy MCP call that took, say, 40 seconds (cold MCP server spawn + tool discovery + an actual tool call that itself round-trips to the live Vercel API) would get aborted by the orchestrator before the bridge ever gave up on its own. Raised to 56000ms.

**This doesn't fully explain your Test 2 finding though** — you ran `hermes chat --oneshot --toolsets "mcp-shawarma" --query "..."` directly, bypassing the bridge and Vercel entirely, and *that* hung too. That means there's a real hang inside Hermes/MCP tool invocation itself, separate from the timeout bug. I can't diagnose that further from here — I have no way to run `hermes` or inspect its process tree. That's where the new logging comes in.

## Added: real-time diagnostics (per your own "Try Next #1")

### `scripts/hermes-bridge.mjs`
- Logs the exact spawn command before launching `hermes chat`.
- Streams `hermes`'s stderr **live** to the bridge's own logs as it arrives (previously it was captured silently and only shown — truncated — if the process exited non-zero; on a *timeout*, all of it was dropped, which is exactly the case that mattered most).
- Logs a heartbeat (`still waiting on hermes chat (pid ...)`) every 10 seconds while a call is in flight, so you can tell "still working" from "silently dead" by watching the bridge's own output.

### `scripts/mcp-server.mjs`
- Logs `-> METHOD /path` to stderr right before each API call it makes, and `<- METHOD /path : status` right after. (stderr, not stdout — stdout is reserved for the MCP protocol itself; writing there would corrupt it.)

## What to do next

**Run the bridge in the foreground** (not backgrounded) so you can watch its stderr live, or make sure whatever launches it captures stderr to a file you're tailing:

```bash
cd /Users/testuser/andshawarma-scheduling
AGENT_API_KEY="shwrm_xxx" HERMES_MCP_TOOLSET="mcp-shawarma" node scripts/hermes-bridge.mjs
```

Then re-run your Test 2 directly (still the most useful isolated test — no Vercel/tunnel involved):

```bash
hermes chat --oneshot --toolsets "mcp-shawarma" --query "list 3 users using the state_read tool"
```

Watch for the MCP server's own log lines (`-> GET /api/state`) — those only appear if the MCP server process is running with its stderr visible somewhere. If you started it standalone for testing, run it directly too and watch its output:

```bash
AGENT_API_KEY="shwrm_xxx" node scripts/mcp-server.mjs
# leave this running, watch its stderr while you run the hermes chat command above from another terminal
```

**Three possible outcomes, and what each one tells us:**

1. **The MCP server never logs `-> GET /api/state` at all.** Hermes isn't invoking the tool — the hang is upstream of our code, inside Hermes's own MCP client/tool-selection logic. At that point I'd want to know: does `hermes chat` print anything to ITS OWN stderr about connecting to the `mcp-shawarma` server, loading its tools, or an error before it goes silent? That's the next thing to grep for.
2. **It logs `-> GET /api/state` but never `<- GET /api/state : ...`.** The hang is in the network call from the MCP server to Vercel. Worth testing that fetch in isolation — `curl -s https://andshawarmaschedulingapp.vercel.app/api/state -H "Authorization: Bearer $AGENT_API_KEY"` from the same Mac, same network path, and see if IT hangs too (would point at something Vercel/network-side) or returns fine (would point at something specific to how the MCP server's own `fetch` call is set up — worth checking Node's fetch/undici version, or whether the process has some odd DNS/proxy config).
3. **Both log lines appear and the call actually returns fast.** Then the hang isn't in the MCP tool call itself — it's somewhere in Hermes's post-tool-call reasoning/response generation. That would need Hermes's own stderr (now streamed live via the bridge) to diagnose further — that's real diagnostic output I don't have, so I'd need you to run the test and share what it shows.

Whichever of these it is, please send me back:
- The exact stderr output from both the `hermes chat` invocation and the MCP server (if it logged anything at all)
- How long it actually took before you gave up watching

That will tell us which of the three cases above we're in, instead of guessing at a fourth fix blind.

## Also still open from earlier handoffs (not forgotten, just not blocking this)
- The hardcoded `AGENT_API_KEY` fallback in `hermes-bridge.mjs` — revoke and replace with an env-var-only key (flagged in `CHAT_BOT_HANDOFF_V4.md`).
- Confirm the exact `hermes mcp add` flag syntax you ended up using is documented somewhere durable (you found the CLI's `--env` handling was broken and fixed the YAML by hand — worth a one-line note in this repo's CLAUDE.md once things are stable, so the next session doesn't rediscover the same YAML bug).

## Files touched this round
- `src/pages/api/agent/chat/index.js` — orchestrator timeout 30000 → 56000
- `scripts/hermes-bridge.mjs` — live stderr streaming, heartbeat, spawn-command logging
- `scripts/mcp-server.mjs` — per-call request/response logging to stderr
