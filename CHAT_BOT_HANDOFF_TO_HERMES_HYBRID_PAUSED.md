# Handoff to Hermes: hybrid action matcher paused

**Date:** 2026-09-21
**From:** Claude Code
**Re:** `CHAT_BOT_HANDOFF_CLAUDE_HYBRID.md`
**Status:** Paused, not built. Owner's call — do not pick this back up without a test harness first.

## What happened

I started implementing `actionsFromState()` per your spec (remove-me and
create-me patterns, deterministic date/time parsing). Got as far as a
working draft locally — never committed or wired into the POST handler.

The owner stopped it: hand-rolled regex date/time parsing that silently
creates or deletes real shifts is exactly the kind of code that shouldn't
ship on "looks right to me." Correct call — a wrong time or wrong date
match here is a silent data-correctness bug, not a cosmetic one.

## Where this stands now

- `scripts/hermes-bridge.mjs` on `origin/main` is unchanged from before
  this handoff — still the plain LLM path (Hermes/MiniMax, or the local
  fine-tuned model as configured fallback). No hybrid matcher present.
- My draft implementation is NOT saved anywhere — I reverted it rather
  than commit unreviewed pattern-matching code. If you want to see the
  approach I was taking (for reference, not to copy verbatim without
  testing), ask and I can redo it in a branch instead of main.

## One real constraint from your own spec, worth keeping regardless of who builds this

`payload.state.users` (as the orchestrator sends it to the bridge) only
carries `username`/`display_name`/`role` — **no `id`**. That means any
deterministic matcher can safely resolve `payload.message.user_id` (the
sender, for self-referencing actions like "remove me"/"schedule me") but
CANNOT safely resolve a named other person ("schedule Jorge Friday 4-10")
to a real `user_id` without guessing. Guessing an id there would silently
schedule/unschedule the wrong person — worse than the current slow-LLM
problem. Two ways forward when this gets picked up again:
1. Scope the matcher to self-only actions (what I was building) and defer
   anything naming someone else to the LLM path, unchanged.
2. Add `id` back into the orchestrator's payload for `state.users` (a
   small orchestrator change, contrary to your original "don't touch the
   orchestrator" — worth revisiting if named-other-person actions matter
   enough to unblock).

## What's actually needed before this gets built for real

A test harness: a script that feeds the matcher a battery of the exact
example phrases from your handoff spec (all the remove/create examples,
plus deliberately ambiguous/adversarial ones — bare numeric time ranges,
messages naming two people, mixed remove+create sentences) and asserts the
resulting `actions` array against known-correct expected output. That's
what makes "looks right to me" become "verified right" for date/time
logic — this class of bug (a wrong but plausible-looking date or time) is
exactly what CLAUDE.md's own `training-data/generate.mjs` already learned
the hard way (see its two-round bug history) is easy to get subtly wrong
and hard to catch by eyeballing.

Not asking you to build the harness — just flagging it as the actual
blocker, so whoever picks this up next (you, me, or someone else) builds
that first rather than repeating the same "draft it, hope it's right"
attempt.
