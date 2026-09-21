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

This canonical format needs one more conversion step before training: turn each
`tool_calls` array into whatever literal text format the base model was trained
to emit function calls in (e.g. Hermes-style `<tool_call>{...}</tool_call>` tags
if using a Nous Hermes-family base model — check that model's own chat template
docs first, don't assume). That conversion script isn't written yet — do it once
a base model is actually chosen, since the exact tag syntax depends on it.

## Status

v1 generator, ~14 categories from `CHAT_BOT_TEST_CASES.md`, deterministic ground
truth, includes multi-turn clarification/correction conversations. Not yet
validated against a real training run — treat as a starting point, not a
finished artifact.
