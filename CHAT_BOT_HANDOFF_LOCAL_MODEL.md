# Handoff: local fine-tuned model for the chat bot

Covers everything done this session toward replacing/supplementing Hermes +
MiniMax with a small, local, fine-tuned model — from dataset generation
through wiring it into `hermes-bridge.mjs`. All of this is already
committed and pushed to `origin/main`; nothing below is at risk of being
lost, this is a summary for orientation.

## Why

Hermes/MiniMax needs per-message API credits and ran out mid-session with
no fallback — the chat bot went fully dark. The goal is a small model,
fine-tuned narrowly on "map a scheduling request to the right tool call,"
running entirely on-device (MLX on Apple Silicon) so it has zero dependency
on any provider's credit balance. Deliberately brand-neutral throughout —
no "&Shawarma" anywhere in the dataset or generator — since the owner
intends to white-label this model across every restaurant deployment using
this scheduling app, not just this one.

## What's built (commits, newest first)

| Commit | What |
|---|---|
| `d469f1e` | Local-model fallback wired into `scripts/hermes-bridge.mjs` |
| `c8c4f47` | `training-data/convert_to_mlx.mjs` + `mlx_lm.lora` fine-tuning instructions in `training-data/README.md` |
| `5e5b9d9` | Spanish (EN/ES) support added to the dataset generator |
| `2eac1c1` | Expanded phrasing-diversity across all 13 categories |
| `6db07c1` | v1 generator + first dataset (613 examples) |

### 1. `training-data/` — the dataset

- `generate.mjs` — deterministic generator (no LLM calls, no label noise).
  13 categories (shift create basic/recurring, availability, time off, swap
  post/claim, removal, read-only queries, multi-action, template-choice
  multi-turn, name-ambiguity multi-turn, off-topic refusal, casual/typo
  phrasing, greetings). Every `tool_calls` value is computed from the same
  scenario params as the phrasing via real date math — never guessed.
- **Bilingual (EN/ES)**: every category randomly renders in English or
  Spanish per example (~46% Spanish in the current 611-example set), with
  real weekday/month/date localization, not just a translated system
  prompt. Two real Spanish grammar bugs were caught and fixed (doubled
  article/preposition on self-reference; "mí" used as a subject, which
  isn't valid Spanish grammar).
- `roster.json` / `templates.json` — generic placeholder fixtures (Alex,
  Sam, Taylor, etc. / Opener, Mid, Late, Weekend Brunch) — swap these for a
  real deployment's actual roster/templates before a production training
  run.
- `dataset.jsonl` — the generated output, regenerate anytime with
  `node training-data/generate.mjs --count 60 --seed 1`.
- Brand-neutrality verified: zero "shawarma" mentions anywhere in the
  generator or output, in either language.

### 2. `training-data/convert_to_mlx.mjs` — MLX conversion

Turns the canonical dataset into the exact chat-format JSONL `mlx_lm.lora`
needs: `training-data/mlx/{train,valid,test}.jsonl` (90/5/5 split),
`tool_calls` rendered in standard OpenAI function-calling shape (the shape
Qwen2.5's own chat template already knows how to turn into its native
`<tool_call>` tags). All 10 MCP tool schemas (from `scripts/mcp-server.mjs`)
are embedded by hand — keep in sync if a tool changes.

### 3. Fine-tuning instructions (`training-data/README.md`)

Documented `mlx_lm.lora` train/test/fuse commands, recommending
`mlx-community/Qwen2.5-3B-Instruct-4bit` as the base model (small/fast
enough for Apple Silicon, natively supports this tool-call format).
**This step can only run on Apple Silicon (MLX), not in a cloud/Linux
session.**

### 4. `scripts/hermes-bridge.mjs` — local-model fallback (this is the wiring)

The bridge already answers the same tunnel URL the Vercel app calls — it
now can serve replies from a locally-running fine-tuned model instead of
spawning `hermes chat`, with **zero code changes needed on the Vercel
side**. New env vars:

- `LOCAL_MODEL_URL` — an OpenAI-compatible chat-completions endpoint (e.g.
  `mlx_lm.server --model training-data/fused-model --port 8081`, once
  fused).
- `LOCAL_MODEL_MODE` — `fallback` (try Hermes, use local only if Hermes
  errors — default once `LOCAL_MODEL_URL` is set), `only` (skip Hermes
  entirely — **use this while MiniMax credits are out**), `primary` (local
  first, Hermes as backup), `off` (default when unset).

`runLocalModel()` builds the same `{messages, tools}` shape the model was
trained on, handles both structured `tool_calls` and scraped
`<tool_call>{...}</tool_call>` text tags (varies by MLX server version),
and converts either into the same `{method, endpoint, body}` action shape
the existing legacy Hermes JSON-block path already produced — so the
orchestrator's `executeAction()` needed no changes.

**Verified end-to-end this session** against a fake local-model HTTP
server standing in for `mlx_lm.server` — structured tool_calls, tag-
scraping fallback, and the Hermes-fails→local fallback mode all produced
correct actions. **Not yet verified against a real fine-tuned model**,
since training hasn't completed yet (see below).

## Where training actually stands right now

Training was started on the Mac (M3, 16GB) and hit a Metal
out-of-memory crash on the very first validation pass — twice, including
after raising the GPU wired-memory ceiling via
`sudo sysctl iogpu.wired_limit_mb=13000`, which had no effect (identical
crash point both times: `Iter 1: Val loss 1.639`, ~190s for validation
alone — unusually slow, suggesting memory pressure during the forward pass
itself, not just at the final OOM).

Next attempted fix (not yet run): `--batch-size 1 --grad-checkpoint` on the
same 16GB machine. You're now considering moving to a 64GB Mac instead,
which would very likely sidestep the memory problem entirely and allow a
higher batch size for faster training.

### Commands to resume on whichever machine you use

```bash
git clone <repo-url> && cd andshawarmaschedulingapp   # or: git pull origin main
python3 -m venv .mlx-venv && source .mlx-venv/bin/activate
pip install mlx-lm

mlx_lm.lora \
  --model mlx-community/Qwen2.5-3B-Instruct-4bit \
  --train \
  --data training-data/mlx \
  --iters 1000 \
  --batch-size 4 \
  --num-layers 8 \
  --adapter-path training-data/adapters \
  --save-every 100
```

If it OOMs on a lower-RAM machine, add `--batch-size 1 --grad-checkpoint`,
or drop to `mlx-community/Qwen2.5-1.5B-Instruct-4bit`.

### After training completes

```bash
# score against held-out test split
mlx_lm.lora --model mlx-community/Qwen2.5-3B-Instruct-4bit \
  --adapter-path training-data/adapters --data training-data/mlx --test

# sanity check by hand
mlx_lm.generate --model mlx-community/Qwen2.5-3B-Instruct-4bit \
  --adapter-path training-data/adapters --prompt "schedule Jorge Tuesday 9 to 3"

# fuse into a standalone model
mlx_lm.fuse --model mlx-community/Qwen2.5-3B-Instruct-4bit \
  --adapter-path training-data/adapters --save-path training-data/fused-model

# serve it locally
mlx_lm.server --model training-data/fused-model --port 8081

# point the bridge at it (skip Hermes entirely while credits are out)
LOCAL_MODEL_URL=http://127.0.0.1:8081/v1/chat/completions \
LOCAL_MODEL_MODE=only \
node scripts/hermes-bridge.mjs
```

## Not yet done

- Training hasn't completed (blocked on the OOM issue above).
- The local model path is verified against a fake server only, not a real
  fine-tuned one yet.
- Missing MCP tool coverage: `swap_post_cancel`, `timeoff_edit`,
  `availability_reschedule`, recurring `availability_rule_create`/`delete`
  — flagged in `CHAT_BOT_TEST_CASES.md` §7, no training examples exist for
  these since no tool exists yet either.
- Spanish phrasing diversity is roughly half of English's per category —
  real coverage, not yet equal depth.
- Distributing the trained model to other white-label deployments: GitHub
  isn't a practical host for ~2GB model weights (100MB hard file limit,
  thin LFS free tier) — Hugging Face Hub is the right tool for that part,
  not yet set up.

## Where this all lives

Everything above is committed on `origin/main`:
- `training-data/generate.mjs`, `roster.json`, `templates.json`,
  `dataset.jsonl`, `convert_to_mlx.mjs`, `mlx/{train,valid,test}.jsonl`,
  `README.md`
- `scripts/hermes-bridge.mjs` (local-model fallback)
- `CLAUDE.md` §11 (documents the local-model fallback in the project's
  living reference)
- This file
