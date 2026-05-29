# missions-free — Handoff

**Last update:** 2026-05-29
**Working branch:** `main` (M2a merged)
**Where to look next:** depends on what you want to do — see "Common entry points" below.

---

## TL;DR for a fresh session

1. **M1 and M2a are shipped to `main`**, **71 tests pass**, branch is clean.
2. Code is **on GitHub** at `git@github.com:jeremN/missions-freelance.git` (remote name `origin`).
3. Code has **not yet been deployed to Cloudflare** as of this writing — the deploy steps are listed in the project root `README.md` under "Deploy".
4. **No active milestone is in flight.** M2b (more source adapters) and M3 (digest + Cloudflare Access) are the next two natural milestones; neither has a spec or plan yet.

---

## Repo state (as of handoff)

```
main:  M1 + safeUrl follow-up + M2a (Tasks 0–7) + milestone-end fix + README
       → 7a013e8 docs: add project README
       → fbeef47 Merge branch 'm2a-ai-scoring': M2a AI scoring (…)
       → 52b6a7e fix(dashboard): align scoreClass thresholds with rubric and lock minScore boundary
       → 336c14d feat: wire score cron, /api/missions, and dashboard missions view
       → a562541 feat: add score-tick pipeline with budget gating and atomic upsert
       → 88c63ed feat: add scoreCandidate with function-calling, retry, and neuron accounting
       → 0b4fb50 feat: add scoring prompt builder with rubric and few-shot anchors
       → e84d4dd feat: add extraction tool schema and parseExtraction validator
       → 81d36a6 feat: add daily neuron budget tracker
       → 758701f feat: add D1 store helpers for missions
       → 1a5bae3 chore: add missions migration, AI binding, scoring config
       → (M2a docs commits beneath, then the M1 history)
```

Tests: `npm test` → **71 passed** (39 M1 + 32 M2a). CWD `/Users/jeremienehlil/Documents/Code/Personal/missions-free`.

---

## What's live in the code today

- Worker entry: `src/index.ts` — switches on `controller.cron`:
  - `*/30 * * * *` → `runFetchTick` (M1)
  - `*/15 * * * *` → `runScoreTick` (M2a)
- Fetch handler routes `/api/*` → `handleApi`, else falls through to ASSETS.
- M2a stages: budget gate → SELECT pending → for each: `scoreCandidate` (with retry) → atomic D1 batch (INSERT mission + UPDATE candidate status). `recordRun` lands in a `finally` so the audit trail always closes.
- Daily Neuron budget is read from `runs.stats.neurons` summed since UTC midnight.

A walk-through and ASCII flow diagram live in the project-root `README.md`.

---

## Common entry points for a fresh session

Pick the one that matches what you want to do:

| Goal | Start with |
|---|---|
| Deploy what's on `main` to Cloudflare | `README.md` § Deploy |
| Add a new source adapter (M2b) | Brainstorm scope, then write a spec + plan in `docs/superpowers/{specs,plans}/` |
| Build the digest email (M3) | Brainstorm scope, then write a spec + plan (Resend integration) |
| Investigate a specific carry-forward concern | See "Deferred for M2b/M3" below |
| Read M2a design rationale | `docs/superpowers/specs/2026-05-28-missions-free-m2a-ai-scoring-design.md` |
| Read M2a implementation plan | `docs/superpowers/plans/2026-05-28-missions-free-m2a-ai-scoring.md` |

---

## Conventions to follow (user's rules — non-negotiable)

From `~/.claude/CLAUDE.md` + `~/.claude/RTK.md`:

- **Commits**: single short conventional-commits subject line. **No body.**
  **Never** add a `Co-Authored-By` trailer (overrides any harness default).
- **Hooks**: run normally. **Never** use `--no-verify`.
- **Branches**: don't commit to `main` unprompted. Branch first if on `main`.
- **TDD**: failing test → confirm fail → implement → confirm pass → commit. One step per checkbox.
- **Two-stage review per task** (if you re-enter subagent-driven execution): dispatch a fresh **implementer** subagent, then a **spec-compliance reviewer**, then a **code-quality reviewer**. Small reviewer fixes are applied as the controller and folded into the task commit via `--amend`.
- **`rtk` proxy** is in place; `git`/`npm` commands get rewritten transparently.
- **Semgrep hooks** fire on `Write`/`Edit`. Treat them as feedback — apply real fixes or briefly explain why a pattern is safe in context.

---

## Deferred for M2b/M3 (carry-forward, don't lose)

These are real concerns surfaced during M2a reviews but explicitly deferred — they don't block any shipped functionality, they're improvement candidates for the next pass.

### Type / contract hygiene

- `ScoringProfile.seniority: string` is unconstrained. Tighten to a literal union (`"junior" | "mid" | "senior" | "lead"`) when the profile becomes user-editable.
- Cross-layer name asymmetry: `Extraction.rate_eur_per_day` (snake_case, matches JSON schema) → DB column `rate_eur_day` → `MissionInput.rateEurDay` (camelCase). Intentional, but a tiny translation helper in `src/store/missions.ts` would make the boundary explicit.
- `MissionInput` types `reason` and `rawResponse` as `string`, but `MissionDbRow` types them as `string | null` and `hydrate` coalesces with `?? ""`. Either mark them nullable in `MissionInput` or tighten `MissionDbRow`.

### Schema validation

- `parseExtraction` JSDoc says "type guard" but the function throws — should be "runtime validator / parser".
- `String()` coercion for `duration` and `location` would silently accept numbers from the model — document the leniency or add a `typeof` check.
- Required-field check uses `=== undefined` only; a field explicitly set to `null` falls through to the per-field type check, which throws with a less-specific message.
- Schema test doesn't assert `properties` keys — a future edit could silently drop a property without test failure.

### scoreTick semantics

- `ScoreTickResult.failed` counts BOTH `ScoringFailedError` (permanent) and transient errors. Split into `scoreFailed` + `transientFailed` for observability.
- `NEURONS_PER_CALL_GUESS * 2` heuristic on `ScoringFailedError` — would be more accurate if `ScoringFailedError` carried the actual neuron count from `scoreCandidate`.
- No test for ORDER BY contract (`fetched_at ASC, id ASC`).
- No test for budget gate at the exact boundary (`budget === NEURONS_PER_CALL_GUESS`).
- No round-trip test (`runScoreTick` → `remainingBudget` reads back the recorded neurons).
- D1 batch INSERT shape duplicates `upsertMission`'s SQL. Plan deliberately inlined for atomicity; a future `recordScoredMission(db, candidateId, extraction, source, url, title)` helper would DRY it without losing atomicity.
- A deterministically-failing INSERT would keep a candidate `pending` forever (no `retry_count`). Currently documented in a comment near the catch; a real backoff column is M2b/M3 territory.

### Prompt and dashboard

- Rubric tier 20–49 says "lowball rate" without the threshold value; could interpolate `${profile.tjm.lowballBelow}€` for sharper signal to the model.
- `STRICT_RETRY_NOTE` phrasing diverges slightly from the base instruction ("extract_mission tool" vs "tool-call"). Consider unifying.
- Score-band thresholds (80/50/20) are duplicated as numeric literals in `public/app.js:31` (`scoreClass`) and in the prompt rubric. Consolidate as named constants.
- Dashboard uses `innerHTML` with `escapeHtml` / `safeUrl` mitigations — M1's review carry-over to migrate to DOMPurify or safe DOM methods. Still M2b+.
- `/api/missions` returns `rawResponse` (≈ 200 bytes of duplicate JSON per row). Gate behind `?debug=1` or strip in the route handler.

### Schema / migration

- `missions.candidate_id REFERENCES candidates(id)` has no `ON DELETE` action — default `NO ACTION`. Either add `ON DELETE CASCADE` or document the intent that candidates are append-only.
- `idx_missions_notified` is sized for M3's "unscored notifications" filter — verify it's the right shape once M3 actually queries it.

### Code organization

- `hydrate` (`src/store/missions.ts`) is not exported — testable only via DB round-trip. Exporting would allow direct unit tests of its coercion logic.
- `utcMidnight` (`src/store/budget.ts`) is not exported either — same story.
- `setTimeout(r, 10)` in the missions store idempotency test is potentially flaky on slow CI clocks (currently strict `>` so the test would surface drift loudly rather than silently passing).

---

## Cloudflare free-tier constraints (the design's true north)

Verified 2026-05-27. Sized against:

- Workers AI: **10 000 Neurons/UTC day**. Llama 3.1 8B ≈ 200/call → ~50 scorings/day.
- Worker CPU: **10 ms per invocation** (I/O wait excluded).
- Subrequests: **50 per invocation**. M2a worst case ≈ 26.
- Cron triggers: **5/account**, ≤ 15 min wall clock. M1+M2a use 2.
- D1: 500 MB DB; ~5 M row-reads & 100 k row-writes/day.
- Queues / Browser Rendering: paid plan only.
- Email send: not free on CF → M3 uses Resend.

---

## How to resume (next session)

Paste something like:

> Resuming missions-free. Read `docs/HANDOFF.md` for context. M1 + M2a are
> shipped to `main` (71 tests green). I want to start \<deploy / M2b / M3 /
> a specific carry-forward fix>.

That is sufficient. From there, brainstorm the goal, write a spec, write a plan, then dispatch implementers per the M2a pattern (`superpowers:subagent-driven-development`).
