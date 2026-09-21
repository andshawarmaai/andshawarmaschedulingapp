# Chat Bot V9 Follow-up — Self-Removal & State Visibility

**Date:** 2026-09-21
**From:** Hermes (scheduling)
**For:** Anyone picking up the chat bot work next session

Three changes landed in this session, all on top of the V9 prompt / hint fixes already
shipped earlier today. **The bridge is the priority fix** — the training data changes only
take effect once the fine-tuned model is retrained.

## What broke

Live chat session at 17:24 UTC: user said **"remove me from the schedule"**. The bot
replied **"you're not on it"**. The user actually had 7 upcoming shifts in the DB
(2026-09-26, 09-29, 10-03, 10-10, 10-17, 10-24, 10-31).

Root cause: the bridge was discarding `state.upcomingShifts` and only injecting the
**count** into the prompt. The model genuinely had no idea what shifts existed, so it
defaulted to "I can't find anything."

## The fixes

### 1. `scripts/hermes-bridge.mjs` — pass real shift data (immediate effect)

**Before** (line 383):
```js
parts.push(`LIVE STATE - upcoming shifts (next 30 days): ${(s.upcomingShifts || []).length}`);
```

**After:**
```js
const upcoming = (s.upcomingShifts || []).map((sh) => ({
  user_id: sh.user_id,
  date: sh.date,
  start_time: sh.start_time,
  end_time: sh.end_time,
}));
parts.push(`LIVE STATE - upcoming shifts (next 30 days): ${JSON.stringify(upcoming)}`);
```

Verified live: same prompt + Ray's 7 shifts + "remove me from the schedule" → 7
`DELETE /api/shifts/by-date` actions emitted, model names the dates in plain English
("Tue Sep 29 and Sat Oct 3").

The orchestrator already filters `state.shifts` to `date >= today` and `.slice(0, 30)`
before passing `state.upcomingShifts` to the bridge (see
`src/pages/api/agent/chat/index.js` line 412), so no change needed there.

### 2. `training-data/generate.mjs` — add `selfShifts` to every example + new category

- `baseContext()` now also generates 0–4 fake `selfShifts` for the current user so every
  category trains against a realistic shift context (not just empty state).
- New `genSelfRemoval(n)` category with 4 sub-cases:
  - **Empty state** ("you have no upcoming shifts" — model must NOT invent)
  - **Full removal** ("remove me from the schedule" → N `shift_delete` calls, one per shift)
  - **Weekday-specific** ("remove me from Tuesday" → filter selfShifts by weekday, delete those)
  - **Read-only** ("what shifts do I have" → answer from selfShifts, no tool calls)

This fills the gap that produced the V9 bug. The old `genRemoval` only covered
manager-removing-someone-else and staff-canceling-own-pending-request; nothing for the
self-removal path.

### 3. `training-data/convert_to_mlx.mjs` — render `selfShifts` in MLX system prompt

The MLX-formatter was also dropping the shift data. Updated `buildSystemContent()` to
append `My upcoming shifts: 2026-11-12 16:00-22:00 (id=...); ...` (or "Mis turnos
próximos: ...none..." in Spanish, with empty-state handling) to the system message.

Same shape as the bridge injects live, so what the model trains on matches what it sees
at inference time.

## Dataset size

- Before: 611 examples
- After: 673 examples (+62 from `genSelfRemoval`)
- New breakdown:
  - `self_removal_full`: 14
  - `self_removal_query`: 40 (mostly the read-only "what shifts do I have" + empty-state)
  - `self_removal_weekday`: 6
  - plus the implicit `selfShifts` field now appearing in every other category's context

## Status

- ✅ Bridge fix live and verified
- ⏳ Training data regenerated; **needs retraining on the 64GB Mac** (or however the OOM
  on the 16GB Mac gets fixed) for the new examples to take effect
- The next model run should converge faster on this scenario because the V9 prompt
  rewrite already made the wording clearer — now the model will also have the data
  to act on

## Files changed

- `scripts/hermes-bridge.mjs` — 1 block (line 383 area)
- `training-data/generate.mjs` — new `genUpcomingShiftsForSelf()` helper, updated
  `baseContext()`, new `genSelfRemoval()` category (~115 lines), wired into the run list
- `training-data/convert_to_mlx.mjs` — `buildSystemContent()` updated (~10 lines)
- `training-data/dataset.jsonl` — regenerated (611 → 673)
- `training-data/mlx/{train,valid,test}.jsonl` — regenerated

## Not addressed (still open)

- The 17:25 "Hermes wasn't reachable" was a transient `hermes chat` CLI exit, not a tunnel
  issue. If it recurs, check the bridge stderr for the actual exit reason.
- The fine-tune's OOM on 16GB Mac still blocks any local-model deploy. This change only
  improves the *next* training run, not the current deployed prompt (which is what
  MiniMax-M3 sees right now and which will respond correctly because of the bridge fix).