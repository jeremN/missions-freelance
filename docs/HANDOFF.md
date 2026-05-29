# missions-free — Handoff

**Last update:** 2026-05-28
**Working branch:** `m2a-ai-scoring`
**Where to look next:** `docs/superpowers/plans/2026-05-28-missions-free-m2a-ai-scoring.md`

---

## TL;DR for a fresh session

1. M1 shipped, merged to `main` (39 tests). Post-merge security fix (URL-scheme allowlist) also on `main`.
2. M2a (AI scoring) **spec + plan are written and committed** on the branch `m2a-ai-scoring`. **No M2a code has been written yet.**
3. **The user has chosen subagent-driven execution** for M2a. Next action is to invoke `superpowers:subagent-driven-development` and dispatch the Task 0 implementer.
4. Branch is checked out, working tree is clean.

---

## Repo state (as of handoff)

```
main:                 M1 fully shipped + `safeUrl` href allowlist follow-up.
m2a-ai-scoring:       branched from main + 2 commits (spec + plan). No code yet.
                      → 0b727f4 docs: add M2a AI scoring implementation plan
                      → a10dbcb docs: add M2a AI scoring design spec
                      → 3dcf38b fix: allowlist http(s) schemes in dashboard hrefs
                      → (and all of M1 history beneath)
```

Tests: `npm test` → **39 passed**. CWD `/Users/jeremienehlil/Documents/Code/Personal/missions-free`.

---

## What M1 delivered (already on `main`)

A Cloudflare Workers freelance-mission scanner running for free on the CF
free tier. Single Worker:

- `scheduled()` cron `*/30 * * * *` → `runFetchTick`.
- `fetch()` serves `/api/candidates`, `/api/stats`, `/api/runs` else falls
  through to static assets in `public/`.
- Reddit `r/forhire` adapter (`[Hiring]` only) → deterministic pre-filter
  (skills, hard-kill, TJM extraction, lowball flag) → D1 store
  (`candidates`, `source_state`, `runs`).
- Dashboard: stat panel + filterable candidate cards. All scraped strings
  escaped via `escapeHtml`, URLs scheme-allowlisted via `safeUrl`.

Not yet deployed to Cloudflare. To go live:

```bash
npx wrangler login
npx wrangler d1 create missions-free          # paste id into wrangler.jsonc
npm run migrate:remote
npm run deploy
```

---

## What M2a will add (when you execute the plan)

Spec: `docs/superpowers/specs/2026-05-28-missions-free-m2a-ai-scoring-design.md`
Plan: `docs/superpowers/plans/2026-05-28-missions-free-m2a-ai-scoring.md`

In one sentence: a **`score` cron tick** (`*/15 * * * *`) that calls
**Workers AI Llama 3.1 8B** with **function-calling** to turn `pending`
candidates into a new `missions` table (structured fields + 0–100 relevance
score + reason), gated by the **10,000 Neurons/day** free allocation.

**8 tasks**, mirroring M1's plan structure:

```
Task 0  Foundation: migration 0002 (missions table), AI binding in
        wrangler.jsonc + Env, scoring config constants.
Task 1  src/store/missions.ts (upsertMission, getMissions, …).
Task 2  src/store/budget.ts (remainingBudget(db, now)).
Task 3  src/scoring/schema.ts (EXTRACTION_TOOL + parseExtraction).
Task 4  src/scoring/prompt.ts (buildScoringPrompt with rubric + few-shot).
Task 5  src/scoring/ai.ts (scoreCandidate w/ retry + neuron accounting).
Task 6  src/pipeline/scoreTick.ts (orchestrator, atomic upsert).
Task 7  Wiring: /api/missions, cron switch case, dashboard missions
        section, end-to-end SELF.fetch integration test.
```

Expected final tests: **~63** (39 M1 + ~24 M2a).

---

## Key design decisions (locked during brainstorming)

These are settled — do not re-litigate without a clear reason:

| Decision | Choice | Why |
|---|---|---|
| M2 scope | Split into **M2a** (scoring) and **M2b** (sources). | Scoring is the value prop; evidence > more sources first. |
| Model | `@cf/meta/llama-3.1-8b-instruct`, swappable via `AI_MODEL` config constant. | French quality + JSON-discipline beats 3B; 50 calls/day fits volume. |
| Output mode | **Function-calling** with JSON schema (`EXTRACTION_TOOL`). | Schema-bound output; eliminates most malformed responses at the model layer. |
| Failure handling | Retry once with stricter prompt → mark candidate `score-failed` if still bad. | Bounded cost, audit trail, no infinite re-scoring. |
| Budget exhaustion | **Defer to next UTC day**. No fallback model, no half-quality work. | Clean and predictable. |
| Neuron accounting | Read `usage.neurons` from response, fall back to `NEURONS_PER_CALL_GUESS=200` if absent. | Honest-pessimistic; never over-spends. |
| `missions` shape | One row per candidate (UNIQUE FK). Keep rows with `is_real_mission: false` for prompt-iteration audit. | M3 digest filters by score+is_real_mission. |
| DI for tests | `scoreCandidate(ai, …)` takes the AI binding as a param; tests inject a fake. | Same DI pattern as M1's adapter ctx. **No real Workers AI calls in CI.** |

---

## Conventions to follow (user's rules — non-negotiable)

From `~/.claude/CLAUDE.md` + `~/.claude/RTK.md` and the M1 workflow:

- **Commits**: single short conventional-commits subject line. **No body.**
  **Never** add a `Co-Authored-By` trailer (this overrides any default).
- **Hooks**: run normally. **Never** use `--no-verify`.
- **Branches**: don't commit to `main` unprompted. If on default branch,
  branch first. We're already on `m2a-ai-scoring`.
- **TDD**: failing test → run (confirm fail) → implement → run (confirm pass)
  → commit. One step per checkbox. Every task's plan has full code already.
- **Two-stage review per task**: dispatch a fresh **implementer** subagent,
  then a **spec-compliance reviewer**, then a **code-quality reviewer**.
  Apply small reviewer-flagged fixes as the controller (proportionate); for
  larger changes re-dispatch the implementer. This caught real M1 bugs.
- **`rtk` proxy** is in place; ordinary `git`/`npm` commands get rewritten
  transparently. You should not need to think about it.
- **Semgrep hooks** will fire on `Write`/`Edit`. Treat them as feedback:
  apply real fixes (M1: log injection in `api.ts`, ReDoS in `prefilter.ts`,
  unbounded `Retry-After` in `http.ts`), or briefly explain why the pattern
  is safe in context.

---

## Patterns established in M1 — reuse in M2a

- **D1 access**: prepared statements + `.bind()` only. Camelcase column
  aliases. `D1Result<{...}>` typed batch helper. See `src/store/db.ts` for
  the canonical shape — `src/store/missions.ts` mirrors it.
- **Test setup**: vitest-pool-workers with `cloudflareTest()` plugin from
  the package root (NOT `defineWorkersConfig` — that API was removed in
  0.16.x). Migrations auto-applied via `test/setup.ts` + `readD1Migrations`.
- **Adapter DI**: anything that does external I/O is injected (M1: `fetchJson`
  in `AdapterCtx`; M2a: `ai` parameter on `scoreCandidate`). Tests pass fakes.
- **Tick orchestrator shape**: see `src/pipeline/fetchTick.ts` for the
  template — `try { for adapter… } finally { recordRun }` with per-adapter
  isolation. `scoreTick` mirrors this exactly.
- **HTTP API**: `handleApi(request, env): Response | null` — null means
  "not my route, fall through to assets". Validates query params (`parseLimit`
  with NaN/negative guards). Sets `cache-control: private, no-store`.
- **Dashboard**: plain HTML+JS in `public/`, no build step. Every dynamic
  value passes through `escapeHtml()` (URLs additionally through `safeUrl`).
  Flagged as a future-hardening candidate (DOMPurify / safe DOM methods),
  but **not in scope for M2a**.

---

## Cloudflare free-tier constraints (the design's true north)

Verified 2026-05-27. These are the limits everything is sized against:

- Workers AI: **10,000 Neurons/day**. Llama 3.1 8B ≈ 200/call → ~50 calls/day.
- Worker CPU: **10 ms per invocation** (I/O wait doesn't count).
- Subrequests: **50 per invocation** (every fetch / D1 / AI call counts).
- Cron triggers: **5/account**, max 15 min wall-clock.
- D1: 500 MB DB; ~5M row-reads & 100k row-writes/day.
- Queues / Browser Rendering: paid plan only (used as a constraint, not a
  blocker — M2a needs neither).
- Email send: not free on CF → M3 uses Resend.

---

## Open questions / known minor issues (carry forward, don't lose)

1. **`usage.neurons` field availability** — Workers AI may or may not expose
   per-call neurons in the response. M2a plan has a `NEURONS_PER_CALL_GUESS`
   fallback and Task 5 tests it explicitly. Confirm against real responses
   during Task 7's optional smoke test.
2. **French extraction quality on Llama 8B** — only validated empirically
   during Task 7 manual smoke. If output is poor, swap `AI_MODEL` to the 70B
   model (one-string change, but expect ~5× Neuron cost → smaller batch).
3. **Dashboard XSS hardening** — `innerHTML` with consistent `escapeHtml`
   is accepted in this codebase but is a code-smell. Future task: migrate
   to safe DOM methods or DOMPurify. Not M2a.
4. **Browser-side test coverage** — the dashboard JS (`safeUrl`, escape,
   render) has zero unit tests because the workers test pool has no DOM
   and the dashboard isn't a module. Future task: jsdom or Playwright +
   modularize `public/app.js`. Not M2a.
5. **`/api/runs` is built and tested** but the dashboard doesn't surface
   the run history yet. M3-ish work.
6. **`for hire` hard-kill term** has no test in `prefilter.test.ts`. Minor
   regression risk; one-line follow-up.
7. **Deployment** — M1 has never actually been deployed to Cloudflare. All
   tests pass against local D1 + Miniflare; first contact with real Workers
   AI is Task 7's optional smoke.

---

## How to resume

In a fresh Claude session, you can paste this:

> Resuming missions-free M2a. Read `docs/HANDOFF.md` for context. We're on
> branch `m2a-ai-scoring`, the M2a plan is at
> `docs/superpowers/plans/2026-05-28-missions-free-m2a-ai-scoring.md`, and
> the user chose subagent-driven execution. Invoke
> `superpowers:subagent-driven-development` and dispatch the Task 0
> implementer.

That is sufficient. The Claude doing the work should:

1. Re-verify the working tree is clean and on `m2a-ai-scoring` (`git status`,
   `git branch --show-current`).
2. Re-verify M1's tests still pass (`npm test` → 39 green).
3. Read this file + the plan.
4. Invoke `superpowers:subagent-driven-development` and walk Tasks 0 → 7,
   dispatching a fresh implementer + spec reviewer + code-quality reviewer
   per task, fixing small issues as controller, re-dispatching for larger
   ones.
5. After Task 7 green, invoke `superpowers:finishing-a-development-branch`
   and offer the merge / PR / keep / discard menu.

The plan's self-review (last section of the plan doc) already cross-checks
the plan against the spec — trust that, no need to redo it.
