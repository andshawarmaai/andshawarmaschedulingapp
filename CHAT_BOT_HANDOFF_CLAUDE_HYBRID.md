# Chat bot hybrid matcher — Claude handoff

**Date:** 2026-09-21, 19:25 UTC
**From:** Hermes (scheduling)
**For:** Claude Code
**Status:** Bridge has a read-only matcher (works). Write actions go through LLM (slow, unreliable). Need a robust pattern matcher for write actions too. **Not done yet.**

## What works today

The chat bot just shipped these fixes (commits on origin/main):
- `770d2b7` — bridge short-circuits read-only questions from state (instant, deterministic)
- `103d6de` — orchestrator executes actions via direct DB calls (no more self-fetch loop)
- `4ad9955` — orchestrator parallelizes action execution

Live verified: "what shifts do I have" → lists all 12 shifts in 300ms.

## What's still broken

Write actions ("remove me from the schedule", "schedule Jorge Friday", etc.) still go through the LLM. Two problems:

1. **Slow** — MiniMax-M3 round-trip is 5-15s even when actions are trivial. With 12 actions queued it can hit Vercel's 60s function timeout (we just saw `Task timed out after 60 seconds` errors).
2. **Unreliable** — the model emits wrong actions or asks for confirmation unnecessarily. Per V8/V9 handoffs: MiniMax-M3 has poor instruction following for shift vs availability, route confirmation, multi-action turns, etc.

## What I want

**Add an `actionsFromState` function to `scripts/hermes-bridge.mjs`** that recognizes common write-action patterns from the user message + payload.state, and returns structured actions directly. The bridge returns `{content, actions}` and the orchestrator executes them.

LLM handles everything else (ambiguous phrasing, edge cases).

## Where to put it

`scripts/hermes-bridge.mjs`, right after `answerFromState()` ends at line 286 (where it `return null;`). Add `actionsFromState(text, payload)` returning `null` (let LLM handle) or `{content, actions: [...]}` (handle directly).

Then wire it into the POST handler at the same spot the read-only short-circuit lives (after line 535).

## Patterns to handle

Based on user behavior so far, these need to "just work":

**Remove (delete) — output `{method: 'DELETE', endpoint: '/api/shifts/<id>', body: {}, summary}` per matching shift:**

- "remove me from the schedule" / "remove me off the schedule" / "take me off" → all my upcoming shifts
- "remove me from Tuesday" / "take me off Tuesdays" → shifts on that weekday
- "remove me from October" / "take me off October" → shifts in that month
- "remove me from October 3rd" / "remove my Oct 3 shift" → shifts on specific dates
- "remove me from next week" / "next week" → shifts in next calendar week
- "remove me for both months" → all upcoming

**Create (shift) — output `{method: 'POST', endpoint: '/api/shifts', body: {user_id, date, start_time, end_time}, summary}`:**

- "schedule me Tuesday 9-5" → shift_create with given time
- "schedule Jorge Friday 4-10" → named person, given time
- "put me down for every Saturday in October" / "every Tuesday in November" → bulk create with weekday expansion
- "I want to work Thursday" / "put me on Thursday" → no time given — pick from templates or user history

**Time defaults:**

- "no time given" + has prior shifts on that weekday → use last shift's exact times
- "no time given" + no prior → use templates (one match one, multiple → ask user with numbered list)
- "morning" → 09:00, "evening" → 17:00 (per existing prompt rules in CHAT_BOT_PROMPT §6)
- "4pm" → 16:00, "4:30pm" → 16:30, etc.
- overnight: "4pm to 1am" → 16:00→01:00 (end_time < start_time = valid)

**Who:**

- "me" / no name → use payload.message.username's user_id
- "schedule <name>" → look up display_name in state.users

**Dates (use the same helpers as the existing CHAT_BOT_PROMPT §5):**

- "today" / "tomorrow" → literal
- "this Tuesday" / "next Tuesday" → first/second occurrence in calendar
- "every <weekday> this month" → all matching weekdays through end of current month, skip past
- "every <weekday> in October" → all matching weekdays in named month, skip past
- "every <weekday>" (no month) → upcoming N weeks? Or current month? Match existing prompt behavior — prefer current month
- explicit dates: "Oct 3" / "10/3" / "2026-10-03" → use literal
- "in N days" → today + N

**Both routes:**

- "10-3" → "October 3rd" (US date format). "3-10" → March 10 or Oct 3? Use US convention: MM-DD unless year is given.
- Conflicting ambiguous phrasing → return null (let LLM handle)

## What to return when ambiguous

If pattern matches but a key piece is missing (e.g., "remove me from" with no date and no shifts), return a `{content: 'Which shifts?...'}` short-circuit like the read-only handler does. No actions.

If pattern doesn't match, return null → LLM gets it.

## What success looks like

- "remove me from the schedule" → instant DELETE actions for all my upcoming shifts (no 5-15s LLM wait)
- "schedule me Tuesday 9-5" → instant POST action
- "tell me a joke" → still goes through LLM (returns null)
- Ambiguous case → still LLM

## Files to read

- `/Users/testuser/andshawarma-scheduling/scripts/hermes-bridge.mjs` — main file (especially CHAT_BOT_PROMPT lines 85-120 for date rules, answerFromState at line 240, the POST handler around line 530)
- `/Users/testuser/andshawarma-scheduling/src/pages/api/agent/chat/index.js` — orchestrator's executeAction at line 108 (the action→DB mapping, for reference on what action shapes the orchestrator accepts)
- `/Users/testuser/andshawarma-scheduling/CHAT_BOT_HANDOFF_V9_FOLLOWUP.md` — the context for all these fixes

## Don't touch

- Don't modify the orchestrator — it's working
- Don't modify the CHAT_BOT_PROMPT — it's still used for LLM fallback path
- Don't break the existing read-only `answerFromState` matcher
- Don't change the action shape — must match what the orchestrator's executeAction expects at /api/shifts, /api/shifts/:id (DELETE), /api/shift-requests, /api/timeoff, /api/swap/posts

## Once done

Build with `cd /Users/testuser/andshawarma-scheduling && npm run build`, commit + push. The bridge runs on the user's Mac (LaunchAgent at `/Users/testuser/Library/LaunchAgents/com.shawarma.hermes-bridge.plist`) and will pick up the new code after a restart: `kill -9 $(pgrep -f 'hermes-bridge.mjs')` then `cd /Users/testuser/andshawarma-scheduling && node scripts/hermes-bridge.mjs &`.

Co-Authored-By: Hermes (scheduling) <noreply@nousresearch.com>