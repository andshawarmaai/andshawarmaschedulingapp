# &Shawarma Scheduling App — Handoff Brief

**Date:** 2026-09-17
**For:** Claude Code (or any agent/human picking this up cold)
**Why this file exists:** the owner may run out of tokens/credits mid-session and wants a clean handoff so a fresh agent can continue the exact same thread of work — bug fixes and feature requests on the Schedule Builder's Day view — without re-deriving context from scratch.

---

## Read this first, in order

1. **This file** — recent history, current state, how to keep going.
2. **`CLAUDE.md`** (repo root) — the living technical reference: full data model, every business rule already built, known gotchas, deployment topology. It is kept up to date after every change **in the same commit as the change** — if something here and in `CLAUDE.md` ever disagree, trust `CLAUDE.md`, it's newer.
3. **`git log --oneline -30`** — every commit message this session was written to be self-explanatory; skimming them is a fast way to see the actual sequence of fixes.

Do not re-explore the codebase from scratch before reading `CLAUDE.md` — it already answers "how does X work," "why is Y built this way," and "what already exists" for nearly everything in this app.

---

## What this is (one paragraph)

A single-restaurant staff scheduling app: Astro 5 (server output) + Vercel + Neon Postgres. Staff submit availability/time-off; an admin/manager builds the real schedule and approves/denies everything from one place, the Schedule Builder (`/admin/schedule`). Deployed to **two** GitHub repos / Vercel projects / Neon databases (dev and customer-facing) — see `CLAUDE.md` §2 for exact URLs and the push/deploy commands. **Always push to both repos and redeploy after every change** — this was done after every commit below and should continue to be done after every future change.

---

## Current state (as of this handoff)

- Working tree is **clean** — everything committed and pushed to both `origin` (`andshawarmaai/andshawarmaschedulingapp`) and `https://github.com/therayally/andshawarmatest.git`.
- Latest commit: `ae36ec5` — "Revert coverage-gap boxes back to exact sub-range sizing."
- Latest production deploy: shipped via `vercel --prod --yes` immediately after that commit, live at the stable alias **`https://andshawarmatest.vercel.app`** (not a `-xxxxx-` per-deploy URL — see the gotcha in `CLAUDE.md` §9 if a report of "my fix isn't showing" comes in; that URL confusion has happened multiple times this project).
- `npm run build` passes clean as of the last commit.
- Local dev data (`db/.local-data.json`, gitignored) is restored to its pre-testing state — every verification pass this session backed it up to `/tmp/local-data-backup-*.json` before seeding test scenarios and restored it afterward. If you find `db/.local-data.json` in an unexpected state, check `/tmp` for a recent backup before assuming it's supposed to look that way.

---

## What just happened (this session's actual story)

This was a single long session almost entirely focused on the Schedule Builder's **Day view timeline** — the calendar that shows real shifts, pending requests, and red "open slot" gaps for under-staffed shift templates. Chronologically:

1. **No-reuse column packing.** Day view used to reuse a horizontal column once an item's time ended, which visually looked like unrelated items "stacking." Added `packNoReuse` (permanent per-item lanes, Day view only; Week view is untouched and still uses the original `packOverlaps`).
2. **Vertical compression.** Day view was too tall to see a whole day without scrolling. Added `DAY_REM_PER_HOUR` (1rem/hour, vs Week's 2.5rem/hour), Day-view-only.
3. **Pending requests were silently "auto-filling" open slots.** A staff member submitting availability that overlapped a gap made the gap shrink/close with zero admin action — looked like auto-assignment. Fixed in `rowsForSweep` (`src/lib/client/coverage.js`) to only count **approved** shifts toward closing a gap, never pending requests.
4. **Drag interactions for approved shifts.** Originally you could only drag an approved shift to a different *date*. Added: (a) dragging an approved shift onto a coverage-block/gap opens the Edit modal prefilled with that block's time; (b) dragging onto blank Day-view timeline space computes a new time from the drop position (snapped to 15 min) and opens Edit with it; (c) dragging an approved shift back onto the roster-name row **un-commits it to pending** (new `db.revertShiftToPending()` + `POST /api/shifts/:id/revert-to-pending`, both DB backends). All three open a review modal or ask `confirm()` first — nothing commits silently.
5. **A real text-clipping bug that looked like a layout bug.** A `min-height` CSS floor added in step 2 wasn't actually tall enough for its own text, so `overflow:hidden` sliced the bottom off every letter — looked exactly like two boxes colliding. Fixed with content-correct minimums (see `CLAUDE.md`'s explicit note to verify with `getBoundingClientRect()`, not just a screenshot, if this class of bug ever reappears).
6. **Gap-box sizing: went back and forth twice, landed on the right answer.** A coverage-gap box for an under-staffed template was originally sized to the *exact* still-uncovered sub-range (accurate, but could visibly resize when a totally unrelated shift moved elsewhere in the day, since any-overlap coverage math means one shift can affect several templates' shortfall at once). Owner asked to "lock" the size to the template's full window — implemented, then **quickly reverted** after confirming (with the real `computeDayCoverage`/`computeTemplateTimeGaps` output, not just a screenshot) that locking the size made a lane's box overstate how many people were still needed during portions of the window that were already covered — a worse problem than the resizing. **Current, confirmed-correct state: exact sub-range sizing.** If a future request asks to "stop the gap boxes from resizing," re-read `CLAUDE.md`'s note on this before touching it again — it's already been tried and explicitly rejected once.
7. Assorted smaller fixes: a garbled/overlapping short-gap label turned out to be the same text-clipping bug, not a second bug; two confusing UI labels ("Time off" vs the unlabeled hour rail below it — added a second "Shift times" label row rather than renaming "Time off," which was actually correct all along); Manage page's "Pending Approvals" card now links to Schedule Builder.

**Every one of these is documented in detail in `CLAUDE.md`** under "Business rules already built" — search for "2026-09-16" to find this session's entries specifically, each with the owner's own words quoted where a design decision came directly from their feedback.

---

## How to keep working on this

### Local dev
```bash
npm install   # if node_modules isn't present
npm run dev   # → http://localhost:4321, local.js backend (db/.local-data.json), auto-seeds 11 test users
```

### Verifying a Day-view change (the pattern used throughout this session)
1. `cp db/.local-data.json /tmp/local-data-backup-<name>.json` — back up first, always.
2. Seed a reproduction scenario with a small Node script writing directly into `db/.local-data.json` (see any commit's conversation for examples — the shape is `{ users, shifts, shift_requests, shift_templates, ... }`; note the DB layer uses **snake_case** keys like `shift_requests`, not `shiftRequests`, even though `/api/state`'s JSON response uses camelCase).
3. Use the Claude Browser tool (or the user's own browser) to log in and navigate — local dev's admin password can be bcrypt-patched temporarily for headless testing: `bcrypt.hashSync('testpass123', 10)` written onto a user's `password_hash`, tested, then the backup restored.
4. For verifying computed values (coverage/gaps) directly instead of eyeballing a screenshot: `const mod = await import('/src/lib/client/coverage.js'); const data = await (await fetch('/api/state')).json(); mod.computeDayCoverage(data.shiftTemplates, data.shifts, data.shiftRequests, '2026-09-20')` from the browser console/`javascript_exec` — this session found a real bug (the text-clipping one) specifically by comparing screenshots against `getBoundingClientRect()` output and finding the screenshots were misleading.
5. `cp /tmp/local-data-backup-<name>.json db/.local-data.json` — restore when done.

### Before calling any change done
`npm run build` must pass. If `src/styles/global.css` was touched, verify comment balance: `(css.match(/\/\*/g)||[]).length === (css.match(/\*\//g)||[]).length` — a stray `*/` inside a comment's own text truncates the rest of the file silently. Full checklist in `CLAUDE.md`'s final section.

### Shipping
```bash
git add <files>            # never a blind `git add -A` — check `git status` first
git commit -m "..."        # end the message with the Co-Authored-By line this repo's sessions use — check a recent commit for the exact line
git push origin main
git push https://github.com/therayally/andshawarmatest.git main
vercel --prod --yes        # deploys whichever project .vercel/project.json points at (andshawarmatest)
```
Update `CLAUDE.md` in the **same commit** as the code change it documents — that's the pattern every commit this session followed, and it's why `CLAUDE.md` has stayed trustworthy instead of decaying.

---

## Things a fresh agent should NOT do

- **Don't touch production data on `andshawarmatest.vercel.app` without explicit authorization.** It holds a real restaurant's actual schedule (shift templates, rosters) that the owner has personally configured — treat it the way you'd treat any live customer's data. Code deploys are fine; writing/editing/deleting live schedule *data* is not, unless the owner explicitly asks for it as a one-off demo action.
- **Don't re-attempt the "lock coverage-gap box sizes" idea** without re-reading point 6 above and the matching `CLAUDE.md` note — it was tried, shown to be wrong via actual computed output, and reverted same-day.
- **Don't assume a per-deploy Vercel URL (`andshawarmatest-<random>-the-ray-ally.vercel.app`) is stale/broken evidence of a failed deploy** — those are always frozen at whatever commit was live when they were created; only the bare `andshawarmatest.vercel.app` alias is current. This has caused real confusion more than once.
- **Don't skip the `npm run build` + CSS-comment-balance checks** — both have caught real, otherwise-invisible bugs this session.
