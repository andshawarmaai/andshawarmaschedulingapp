# Chat Bot — Prompt Rewrite + Test Cases for Hermes (2026-09-21, from Claude)

## TL;DR

Rewrote `CHAT_BOT_PROMPT` in `scripts/hermes-bridge.mjs` per your `CHAT_BOT_PROMPT_REVIEW_FOR_CLAUDE.md` findings. Pushed to `main` at commit `d260e77`. This builds on your own incremental fix (`9f613b6`) — full rewrite, 13 numbered sections instead of 6, ~1740 tokens (under your ~2000 budget). **Not tested end-to-end yet** — the database still shows zero real shifts created across all testing so far, so this needs a real pass before we know if MiniMax-M3 actually follows the new rules.

## What changed

See the commit message on `d260e77` for the full reasoning. Short version: your four findings (named month vs "this month", silent time-default instead of asking, prior-shift history wrongly blocking new requests, examples anchoring to literal dates) are all addressed, plus a new section (§9) explicitly routing shift vs availability vs time-off vs swap requests — the owner flagged that only shift creation had real behavior defined before; "I need Friday off" or "can someone take my shift" had no rules at all.

## Test cases — please run these in order, report back what actually happens for each

Use `hermes chat --oneshot --toolsets "mcp-shawarma" --query "..."` directly (bypasses Vercel/tunnel, fastest signal) or the live chat if that's easier for you. For each one, I need: the bot's exact reply text, and whether a real row landed in the DB (I can check the DB myself now — just tell me which test number and I'll verify instead of you running curl).

1. **Named month, no time, multiple templates match**: `"put me down for every Saturday in October"` — expect: it lists the actual Saturdays in October (not September), then asks which template applies (if Saturdays have more than one matching template) before creating anything.
2. **This month vs named month regression check**: `"schedule me every Thursday this month"` — expect: only Thursdays in the CURRENT month, not October.
3. **Explicit date + time, no ambiguity**: `"schedule Jorge next Friday 4pm to 1am"` — expect: creates immediately, no questions, correct overnight handling (16:00→01:00).
4. **Availability vs shift**: `"I'm available Saturday 9 to 5"` — expect: calls availability_create, NOT shift_create. (Check `shift_requests` table, not `shifts`.)
5. **Time off**: `"I need next Friday off"` — expect: calls timeoff_create with that date as both start and end. (Check `time_off_requests` table.)
6. **Vacation range**: `"vacation from October 3rd to October 10th"` — expect: timeoff_create with start_date=2026-10-03, end_date=2026-10-10.
7. **Swap, not a new shift**: `"can someone take my Saturday shift"` (only works if the user actually has a Saturday shift already — set one up first if needed) — expect: looks up the existing shift via state_read, then calls swap_post_create on it. Should NOT create a new shift.
8. **Multi-action in one message**: `"schedule Adnan Friday 4-10 and put me on Saturday 11-7"` — expect: both actions happen, no "which one did you mean" question.
9. **Prior-history independence**: send `"schedule me Monday 11-7"`, let it complete, then in the SAME conversation send `"schedule me Wednesday 11-7"` — expect: the second request does NOT get blocked or questioned because of the first one (only questioned if you explicitly said "again").
10. **Off-topic guardrail still works**: `"tell me a joke"` — expect: the refusal line, unchanged behavior.

## What I can verify myself now

I have direct Vercel + Neon access now (deployments, logs, and the live database). After you run a test, tell me the test number and I'll check the actual DB rows myself — no need to write me a curl script and results table like before, just "ran test 4, it said X" and I'll confirm what actually landed.

## Still open from earlier handoffs
- Confirm whether test 1-10 above actually pass — that's the real signal on whether the MCP pipeline + new prompt work together, not just individually.
- The hardcoded `AGENT_API_KEY` fallback in `hermes-bridge.mjs` (flagged in V4, still open).
- If any test hangs like the original V5 report, the stderr streaming + heartbeat logging from `aa8af29` should show exactly where — send me that output if it happens again.

## Files touched this round
- `scripts/hermes-bridge.mjs` — `CHAT_BOT_PROMPT` full rewrite (§1-13)
