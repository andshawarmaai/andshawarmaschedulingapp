# Chat Bot Hybrid Matcher — Hermes (scheduling), 2026-09-21

**From:** Hermes (scheduling)
**Re:** Resumption of the hybrid action matcher work paused earlier today in `CHAT_BOT_HANDOFF_TO_HERMES_HYBRID_PAUSED.md`
**Branch:** `feature/chat-pattern-matcher` (off `main` so a bad merge can't take live data out — per the owner's previous pause)
**Status:** Built, tested. **Not deployed to the running bridge yet.** The current PID 11819 bridge in `/Users/testuser/Library/LaunchAgents/com.shawarma.hermes-bridge.plist` still runs the pre-matcher code.

## What this fixes

Two of the three V8 test failures (`CHAT_BOT_HANDOFF_V8_TEST_RESULTS.md`):
1. **Shift vs availability routing** — "put me down for every Saturday in October" now reliably emits `POST /api/shifts` instead of `availability_create`. The matcher hard-codes it.
2. **Self-removal speed & correctness** — "remove me from the schedule" returns its DELETE actions in <1ms from the matcher, no LLM call, no 5-15s MiniMax-M3 round trip, and the V9 prompt's passing "1 of 5 → all 5 Saturdays" count is now correct (5 Saturdays, not 4).
3. **Off-topic refusal**: still handled by the existing `isOffTopic()` layer above `match()` — the matcher's job is structural, not refusal.

Plus an unmentioned bonus: every "schedule me X" / "remove me from X" call now skips the LLM entirely, so the chat bot stops timing out at 60s on multi-action requests and stops burning API credits per routine edit.

## What's here

| File | What |
|---|---|
| `scripts/hermes-bridge.mjs` | New `match()` function (pure, exported, optionally `opts.today` for tests), wired into the POST handler between `answerFromState` and `buildPrompt`. Module-level `isDirectRun` guard so `node --test` can import the module without binding port 7890. |
| `test/chat-hybrid.test.mjs` | 25 tests, all green. Covers off-topic defer, every remove-me phrasing in the hybrid handoff spec, schedule-me with single date / weekday / named month / numeric date / US vs DD-MM, cross-midnight times, AM-PM-no-suffix defaulting to 09-17, no-time fallback to last weekday's times or templates, ambiguous case deferral to LLM, and the named-other-person deferral (the original `CHAT_BOT_HANDOFF_CLAUDE_HYBRID.md` concern about `state.users` having no id). |

## What still needs the LLM (deferred cases, all return `null` from `match()`)

- Any phrase naming someone other than the sender (`schedule Jorge Friday 4-10`). Intentional — we can't safely resolve a user_id from a name string without it.
- Truly ambiguous inputs ("gibberish", "I'm bored", pure greetings).
- Anything the helpers can't deterministically date/time.

## How to deploy this

DO NOT just `kill -9` the running PID without next steps — the LaunchAgent has `KeepAlive SuccessfulExit=false`, so killing it makes launchd restart it from the SAME file path; if there are typos in the new code, the restart will keep crashing. Sequence:

1. `cd /Users/testuser/andshawarma-scheduling && git checkout feature/chat-pattern-matcher` (already on it; verify with `git branch --show-current`).
2. **Smoke-test the matcher in isolation (no server needed):**
   ```bash
   node --test test/chat-hybrid.test.mjs
   # Expect: tests 25 / pass 25 / fail 0
   ```
3. **Restart the bridge** so launchd picks up the new code:
   ```bash
   kill -9 $(pgrep -f 'hermes-bridge.mjs')
   # launchd auto-restarts via KeepAlive; OR start manually:
   cd /Users/testuser/andshawarma-scheduling && nohup node scripts/hermes-bridge.mjs >/tmp/hermes-bridge.log 2>&1 &
   ```
4. **Sanity-test the live chat bot from the app** with one of the now-fast phrases:
   - "remove me from the schedule" → should reply in <500ms with N DELETE actions (instead of 5-15s with N actions)
   - "schedule me Tuesday 9-5" → similar
5. **Tail the bridge log** while testing:
   ```bash
   tail -f /tmp/hermes-bridge.log | grep -E 'hybrid-action|off-topic|direct-answer'
   ```
   Expected lines like `[ts] hybrid-action short-circuit for: remove me from the schedule (3 actions)` confirm the matcher fired.

## How to revert if something goes wrong

```bash
cd /Users/testuser/andshawarma-scheduling
git checkout main
# Kill the bridge; launchd restarts on the old code path:
kill -9 $(pgrep -f 'hermes-bridge.mjs')
```

The new matcher is `if (hybridAction !== null)` inside the POST handler, with `hybridAction = match(userMsg, payload)`. Removing that block returns the bridge to the V9 state — no other lines were touched.

## Known limits (intentional, in case someone tries to extend)

- **Self-only scope.** Adding `id` to `state.users` in the orchestrator was the path Claude's pause-handler explicitly considered; I held off because that touches a working file with cross-bot dependencies (the chat panel, the API guide generator, etc.). Whoever extends the matcher to handle named-other-person actions MUST also add `id` to the orchestrator's payload, document it in `src/pages/api/agent/chat/index.js` line 35, and regenerate `AGENT-TRAINING.md`.
- **No time-zone awareness.** All date math is UTC; the bridge's `TODAY'S DATE` line uses America/New_York for the LLM, but the matcher's `opts.today` defaults to UTC. For real-world use this is fine (single-restaurant), but `opts.today` should be set from the same source as `buildPrompt` if multi-TZ ever becomes relevant.
- **No "broadening" on zero-match.** "Remove me from Tuesday" with no shift on the next calendar Tuesday returns `{content: 'No upcoming shifts match…', actions: []}` instead of silently reaching for the next-Tuesday-with-a-shift. That broadening was a deliberate reject (would silently delete a different week's shift). If you want to add it: parser-side, with an explicit "would you mean Tuesday the 29th?" confirmation — NOT a silent pick.
