# Chat Bot Fine-Tune Training Data

Synthetic training data for fine-tuning a small local model to act as this app's
chat bot interface controller — map natural-language scheduling requests to the
correct MCP tool call(s), nothing more. See `CHAT_BOT_TEST_CASES.md` (repo root)
for the human-readable eval set this is generated from the same taxonomy as.

## Format

`dataset.jsonl` — one JSON object per line, each representing a full conversation
(1+ turns). Intermediate/canonical format, not locked to one fine-tuning
framework's exact chat template — convert before feeding to `mlx_lm.lora` (see
"Converting" below).

```json
{
  "id": "shift_create_0042",
  "category": "shift_create_basic",
  "context": {
    "today": "2026-09-21",
    "users": [{"username": "jorge", "display_name": "Jorge"}, ...],
    "templates": [{"name": "Opener", "start_time": "09:00", "end_time": "15:00", "days_of_week": [1,2,3,4,5]}, ...]
  },
  "messages": [
    {"role": "user", "content": "schedule Jorge next Friday 4pm to 1am"},
    {
      "role": "assistant",
      "content": "Done - Jorge is on Friday Sep 25, 4pm to 1am.",
      "tool_calls": [
        {"name": "shift_create", "arguments": {"user_id": "<jorge-id>", "date": "2026-09-25", "start_time": "16:00", "end_time": "01:00"}}
      ]
    }
  ]
}
```

Multi-turn example (clarifying question + resolution):

```json
{
  "id": "template_ask_0007",
  "category": "no_time_ask_template",
  "context": { "today": "2026-09-21", "users": [...], "templates": [...] },
  "messages": [
    {"role": "user", "content": "put me down for Saturday"},
    {"role": "assistant", "content": "1. Opener 9a-3p\n2. Late 4p-10p\nWhich one?", "tool_calls": []},
    {"role": "user", "content": "2"},
    {
      "role": "assistant",
      "content": "Done - you're on Saturday Sep 26, 4pm to 10pm.",
      "tool_calls": [
        {"name": "shift_create", "arguments": {"user_id": "<self-id>", "date": "2026-09-26", "start_time": "16:00", "end_time": "22:00"}}
      ]
    }
  ]
}
```

An assistant turn with `"tool_calls": []` means "no action this turn" (a
clarifying question, a read-only answer, or an off-topic refusal) — the model
needs negative examples just as much as positive ones, or it over-calls tools.

## Files

- `generate.mjs` — the generator script. Deterministic: every "correct answer" is
  computed from the same scenario parameters as the phrasing, never guessed.
  Re-run with a different `--count` to scale the dataset up.
- `dataset.jsonl` — the generated output (gitignored if it gets large; regenerate
  with `node training-data/generate.mjs` rather than trusting a stale committed copy).
- `roster.json` / `templates.json` — the fixture data (names, shift templates)
  the generator draws from. Update these to match the real live roster before a
  real training run, not the demo data baked in here.

## Converting for `mlx_lm.lora`

`convert_to_mlx.mjs` turns the canonical `dataset.jsonl` into the chat-format
JSONL `mlx_lm.lora` expects — one `{"messages":[...], "tools":[...]}` object
per line, split into `training-data/mlx/{train,valid,test}.jsonl` (90/5/5).
Each `tool_calls` array is rendered in the standard OpenAI function-calling
shape (`{id, type:"function", function:{name, arguments: <JSON string>}}`) —
this is the shape Qwen2.5's own tokenizer chat template already knows how to
turn into its native `<tool_call>{...}</tool_call>` text at train/inference
time via `tokenizer.apply_chat_template(messages, tools=tools)`, so nothing
downstream needs its own custom tag syntax. **If a different base model
family is chosen instead of Qwen2.5, check that model's own chat template
first** — a Hermes-family or Llama-3-family base model expects a different
tool-call tag syntax, and this script's OpenAI-shape `tool_calls` output may
need adjusting (or may already be compatible, if that model's template also
accepts the OpenAI shape — increasingly common, but verify, don't assume).
The 10 tool schemas embedded in this script mirror `scripts/mcp-server.mjs`'s
`registerTool` calls by hand — keep them in sync if a tool's inputSchema
changes there.

```bash
node training-data/convert_to_mlx.mjs
```

## Fine-tuning on an Apple Silicon Mac (`mlx_lm.lora`)

**This part cannot run in a cloud/Linux session — MLX only runs on Apple
Silicon.** Run this on the Mac itself (or have Hermes run it there).

```bash
# one-time setup
python3 -m venv .mlx-venv && source .mlx-venv/bin/activate
pip install mlx-lm

# pick a base model — Qwen2.5-3B-Instruct-4bit is a reasonable first choice:
# small/fast enough for a 16GB M3, and its chat template natively supports
# the OpenAI-shape tool_calls this conversion script produces. Qwen2.5-1.5B
# is a faster/lighter fallback if 3B is too slow for the target latency.
mlx_lm.lora \
  --model mlx-community/Qwen2.5-3B-Instruct-4bit \
  --train \
  --data training-data/mlx \
  --iters 1000 \
  --batch-size 4 \
  --num-layers 8 \
  --adapter-path training-data/adapters \
  --save-every 100

# evaluate on the held-out test split
mlx_lm.lora \
  --model mlx-community/Qwen2.5-3B-Instruct-4bit \
  --adapter-path training-data/adapters \
  --data training-data/mlx \
  --test

# try it interactively before fusing
mlx_lm.generate \
  --model mlx-community/Qwen2.5-3B-Instruct-4bit \
  --adapter-path training-data/adapters \
  --prompt "schedule Jorge Tuesday 9 to 3"

# fuse the LoRA adapter into a standalone model once happy with it
mlx_lm.fuse \
  --model mlx-community/Qwen2.5-3B-Instruct-4bit \
  --adapter-path training-data/adapters \
  --save-path training-data/fused-model
```

## Wiring the fused model into the chat bot

Once fused, serve it locally as an OpenAI-compatible endpoint and point
`scripts/hermes-bridge.mjs` at it — this makes zero MiniMax API calls per
message, so it keeps working regardless of Hermes's own credit state:

```bash
mlx_lm.server --model training-data/fused-model --port 8081
```

Then start the bridge with:

```bash
LOCAL_MODEL_URL=http://127.0.0.1:8081/v1/chat/completions \
LOCAL_MODEL_MODE=only \
node scripts/hermes-bridge.mjs
```

`LOCAL_MODEL_MODE=only` skips Hermes entirely (use this while MiniMax
credits are out); `fallback` (the default once `LOCAL_MODEL_URL` is set)
tries Hermes first and only uses the local model if Hermes errors;
`primary` is the reverse. See the `LOCAL_MODEL_*` constants near the top of
`hermes-bridge.mjs` for the full routing logic, and CLAUDE.md §11 for the
incident that motivated this (Hermes running out of MiniMax credits
mid-session with no fallback at all). Verified end-to-end against a fake
local-model server standing in for `mlx_lm.server`; not yet verified
against a real fine-tuned model, since no training run has happened yet.

`--iters 1000` with `--batch-size 4` over ~549 train examples is roughly
7-8 epochs — a reasonable starting point for a dataset this size, not a
tuned value. Watch `valid` loss in the training log; stop early (lower
`--iters`, or just kill it and use an earlier `--save-every` checkpoint) if
it starts climbing while train loss keeps dropping (overfitting — more
likely on a dataset this size than underfitting). If it plainly isn't
learning the format at all, `--num-layers` (how many of the model's layers
get LoRA-adapted) is the first knob to raise before touching data size.

None of these exact numbers have been validated against a real run yet —
they're a documented starting point, not a proven recipe. Update this
section with what actually worked once a real training run has been done.

## Status

**v1.1, generated and spot-checked, now bilingual (EN/ES).** `generate.mjs`
implements 13 categories (shift creation - basic and recurring, availability,
time off, swap post/claim, removal, read-only queries, multi-action,
template-choice with numbered-list multi-turn resolution, name-collision
ambiguity multi-turn, off-topic refusal, casual/typo phrasing, pure
greetings). Deterministic ground truth throughout - every `tool_calls` value
is computed from the same scenario parameters as the phrasing via real date
math, never guessed or LLM-generated. Phrase-template banks were expanded
per category (4-14+ variants each) so `--count 60` doesn't just repeat a
handful of sentences with different names/dates swapped in.

**Spanish support (added to mirror the live app's own EN/ES staff toggle,
`src/lib/i18n.js`):** every one of the 13 categories now randomly picks
`en`/`es` per example (`row.lang`, roughly 50/50) and renders that example's
user message, assistant reply, weekday/month names, and date formatting
("26 de enero" vs "Jan 26") in the chosen language — not just a translated
system prompt with English examples underneath. `botIdentityLine()` also has
a Spanish system-prompt variant. Real Spanish grammar was checked by hand,
not assumed: self-reference ("mí") is only ever placed in object position
(`pon a mí...`), never as a sentence subject, since two rounds of spot-check
caught real breakage there (see bugs below) — a handful of subject-first
English templates ("X needs to work...", "X va a trabajar...") are
deliberately excluded from the self-reference pool in both languages for the
same reason. Spanish phrasing diversity is real but intentionally narrower
than English's (roughly half as many variants per category) — this is a
first pass at bilingual coverage, not full parity; widen `*Es` phrase banks
the same way the English ones were widened if the model under- or
over-fits on Spanish phrasing.

Run `node training-data/generate.mjs --count 60 --seed 1` to regenerate (611
examples at count=60, ~46% Spanish; scale `--count` up for more). Spot-checked
by hand after every generation round — bugs found and fixed this way:
- `nextWeekday` vs `thisWeekday` date-math bug in time-off (v1)
- a broken 12-hour time formatter in the template-choice list (v1)
- a single-arg swap-claim phrase template called with two args, silently
  dropping the day label (v1)
- Spanish self-reference producing "el este lunes" (double article) and
  "a a mí" (doubled preposition) when a template that already carried its
  own "el "/"a " literal was fed a day-label or name-label that also carried
  one (v1.1)
- Spanish self-reference substituted into subject-first templates producing
  ungrammatical "mí va a trabajar..." / "mí necesita trabajar..." — "mí" is
  never a grammatical subject in Spanish, only ever object/prepositional
  (v1.1)

Re-spot-check after any further edits to `generate.mjs` rather than trusting
it blindly — every one of the bugs above passed `node --check` (syntax is not
correctness).

Brand-neutral by design - no restaurant name appears anywhere in the generated
data or the generator itself (verified: `grep -i shawarma` over the output
returns nothing, in both languages). Roster (`roster.json`) and templates
(`templates.json`) are generic placeholder fixtures, not tied to any specific
deployment's real data.

**Not yet done:**
- Not validated against a real training run (`mlx_lm.lora` or otherwise) -
  the fine-tuning commands in this README are a documented starting point,
  not a proven recipe yet.
- Missing tool coverage matches the gaps flagged in `CHAT_BOT_TEST_CASES.md`
  (§7 there): `swap_post_cancel`, `timeoff_edit`, `availability_reschedule`,
  and recurring weekly `availability_rule_create`/`delete` have no MCP tool
  built yet, so no training examples exist for them either.
- Spanish phrasing diversity is roughly half of English's per category (see
  above) - real coverage, not yet equal depth.
