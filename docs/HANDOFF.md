# missions-free — Handoff

**Last update:** 2026-05-29 (post-M2b, post-deploy)
**Working branch:** `main`
**Where to look next:** depends on the goal — see "Common entry points" below.

---

## TL;DR for a fresh session

1. **M1 + M2a + M2b are all shipped to `main`**, **86 tests pass**, working tree clean.
2. **The Worker is deployed and running on Cloudflare** at
   `https://missions-free.jeremn-code.workers.dev` — both crons live (`*/30`
   fetch, `*/15` score). First firings produce live data without any action.
3. Code is on GitHub at `git@github.com:jeremN/missions-freelance.git`
   (remote `origin`, `main` tracks).
4. **No active milestone is in flight.** The next two natural milestones:
   - **M2c** — resolve WTTJ + add more sources (Hellowork, Telegram). See
     "M2c decision point" below for the open WTTJ-Algolia question.
   - **M3** — daily digest email (Resend) + Cloudflare Access in front of
     the dashboard.

---

## Deployed infrastructure (as of handoff)

| | |
|---|---|
| Worker URL | `https://missions-free.jeremn-code.workers.dev` |
| Worker version ID | `a1c9597d-079c-412b-95ff-2abb77fa9fe6` (2026-05-29) |
| D1 database | `missions-free` |
| D1 UUID | `39254e3d-09ea-4e82-96f5-91096e08aff4` |
| D1 region | WEUR |
| Bindings | `DB` (D1) + `AI` (Workers AI) + `ASSETS` (public/) |
| Crons | `*/30 * * * *` → `runFetchTick`, `*/15 * * * *` → `runScoreTick` |
| Migrations applied | `0001_init` + `0002_missions` |
| Dashboard | https://missions-free.jeremn-code.workers.dev/ |

To redeploy after code changes:

```bash
npm run deploy            # publishes the current main
npx wrangler d1 migrations apply missions-free --remote  # only if new migration
```

---

## Repo state (as of handoff)

```
main (deployed):
  → bcfe6f1 chore(deploy): pin missions-free D1 database_id
  → 183f8ac Merge branch 'm2b-source-adapters': M2b Free-Work source adapter (WTTJ dropped to M2c)
  → c5d0dfb fix(http): treat 204 No Content as null body in fetchText (match fetchJson)
  → 90fbde0 feat: register free-work adapter and ship M2b (Free-Work-only)
  → 46bad29 docs: drop WTTJ from M2b scope after Algolia recon
  → 2e3a83e feat: add free-work source adapter
  → 21614de feat: add RSS-2.0 and Atom feed parser via HTMLRewriter
  → d12a991 feat: add fetchText sibling to fetchJson via createFetchClients factory
  → b14ec3d docs: add M2b source-adapters implementation plan
  → 7e82f3e docs: add M2b source-adapters design spec
  → 2df0035 docs: add MIT LICENSE and refresh HANDOFF for post-M2a state
  → 7a013e8 docs: add project README
  → fbeef47 Merge branch 'm2a-ai-scoring': M2a AI scoring (Workers AI Llama 3.1 8B, ...)
  → (M2a history beneath, then M1)
```

Tests: `npm test` → **86 passed** (39 M1 + 32 M2a + 15 M2b). CWD `/Users/jeremienehlil/Documents/Code/Personal/missions-free`.

---

## What's live in the code today

- Worker entry: `src/index.ts` — switches on `controller.cron`:
  - `*/30 * * * *` → `runFetchTick` (M1 + M2b adapters)
  - `*/15 * * * *` → `runScoreTick` (M2a)
- Fetch handler routes `/api/*` → `handleApi`, else falls through to ASSETS.
- **Three sources registered**: `redditAdapter` (M1, r/forhire), `freeWorkAdapter` (M2b, Free-Work Hydra JSON-LD API).
- **`fetchText` + `parseRssItems`** infrastructure ready for M2c's RSS sources (Hellowork, future).
- M2a pipeline unchanged — budget gate → SELECT pending → for each: `scoreCandidate` → atomic D1 batch (INSERT mission + UPDATE candidate status). `recordRun` in `finally` guarantees audit trail.

---

## First 24–48 hours after first deploy — what to check

These are the empirical questions that CI cannot answer.

1. **Did the first fetch tick produce any candidates?**
   `curl https://missions-free.jeremn-code.workers.dev/api/stats | jq`
   Expect non-zero `totalCandidates` within 30 min of deploy.

2. **Did the first score tick produce any missions?**
   `curl https://missions-free.jeremn-code.workers.dev/api/missions | jq`
   Expect 1–8 missions within 45 min of deploy.

3. **Are `usage.neurons` values present in `runs.stats.neurons`, or is the
   guess fallback kicking in?**
   `curl https://missions-free.jeremn-code.workers.dev/api/runs | jq '.runs[] | {tick, stats: .stats | fromjson}'`
   If `neurons` is consistently 200 across many score ticks, that's the
   `NEURONS_PER_CALL_GUESS` fallback — Workers AI isn't exposing the real
   cost. Document this in §11.x of the spec for posterity; budget tracking
   still works but is honest-pessimistic only.

4. **Llama 3.1 8B's French-extraction quality.**
   Read 5–10 `missions.reason` lines. Are they coherent? Does the score
   match the rubric? If quality is poor:
   - Swap to a stronger model: change `AI_MODEL` in `src/config.ts` to
     `"@cf/meta/llama-3.3-70b-instruct-fp8-fast"` (≈5× neuron cost; reduces
     daily volume to ~10 scorings).
   - Re-deploy: `npm run deploy`.

5. **Free-Work signal-to-noise.**
   Free-Work's `?contracts=contractor` is inclusive — postings tagged
   `["contractor", "permanent"]` come through too. Look at the scored
   missions for ~10 cycles; if more than ~30% of `is_real_mission: false`
   results come from Free-Work, consider adding a post-filter on `contracts`
   to the adapter.

6. **Source-state ETag behavior.**
   Reddit honors ETag → after the first tick, `runs.stats.fetched` drops to
   0 until new posts. Free-Work has `cache-control: no-cache, private` →
   never 304s. Both are expected.

---

## M2c decision point — WTTJ-Algolia question

The M2b spec §11.1 documents the WTTJ finding: their job search is backed by
**Algolia with a referer-locked public API key**. M2b dropped WTTJ to ship
Free-Work-only. M2c needs to either resolve this or move on without WTTJ.

Three viable M2c approaches (pick during M2c brainstorm):

| Approach | What it adds | Trade-off |
|---|---|---|
| **A. Skip WTTJ; add Hellowork + Telegram instead** | 2 new adapters (RSS + Telegram Bot API) | Compatible with `parseRssItems` already shipped; clean ethics; Telegram needs a bot setup. |
| **B. Add WTTJ via Algolia + Referer spoof** | 1 WTTJ adapter | Faster to ship; rotation-risk; in the grey zone. Document explicitly. |
| **C. Hellowork only** | 1 adapter | Smallest M2c; bias toward steady incremental adds. |

The decision is essentially: "how much do we want WTTJ specifically vs.
general FR-freelance coverage?" Volume-wise, Hellowork + Free-Work + Reddit
already saturate the M2a Neuron budget most days.

---

## Common entry points for a fresh session

Pick the one that matches what you want to do:

| Goal | Start with |
|---|---|
| First 24h watch (no code change) | `curl /api/stats` / `/api/runs` / `/api/missions` against the live worker — see §"First 24–48 hours" above |
| Tune the user profile (skills, hardKill, TJM) | Edit `src/config.ts` → `npm test` → `npm run deploy` |
| Swap to a stronger AI model | Edit `AI_MODEL` in `src/config.ts` → `npm run deploy` |
| Start M2c (more source adapters) | Brainstorm scope (Hellowork? Telegram? WTTJ-Algolia?), then write a spec + plan in `docs/superpowers/{specs,plans}/` |
| Start M3 (digest email + Access) | Brainstorm Resend integration; plan Cloudflare Access in front of `/` and `/api/*` |
| Investigate a carry-forward concern | See "Deferred for M2c/M3" below |
| Read M2b design rationale | `docs/superpowers/specs/2026-05-29-missions-free-m2b-source-adapters-design.md` |
| Read M2a design rationale | `docs/superpowers/specs/2026-05-28-missions-free-m2a-ai-scoring-design.md` |
| Read original scanner spec | `docs/superpowers/specs/2026-05-27-missions-free-scanner-design.md` |

---

## Conventions to follow (user's rules — non-negotiable)

From `~/.claude/CLAUDE.md` + `~/.claude/RTK.md`:

- **Commits**: single short conventional-commits subject line. **No body.**
  **Never** add a `Co-Authored-By` trailer (overrides any harness default).
- **Hooks**: run normally. **Never** use `--no-verify`.
- **Branches**: don't commit to `main` unprompted. Branch first if on `main`.
- **TDD**: failing test → confirm fail → implement → confirm pass → commit.
- **Two-stage review per task** (if re-entering subagent-driven execution):
  implementer subagent → spec-compliance reviewer → code-quality reviewer.
  Small reviewer fixes are applied as controller and folded into the task
  commit via `--amend`.
- **`rtk` proxy** is in place; `git`/`npm` commands get rewritten transparently.
- **Semgrep hooks** fire on `Write`/`Edit`. Treat them as feedback — apply
  real fixes or briefly explain why a pattern is safe in context.

---

## Deferred for M2c / M3 (carry-forward, don't lose)

Cumulative list across M1, M2a, M2b reviews. Items are real but were
explicitly out of scope for their original milestone.

### Type / contract hygiene

- `ScoringProfile.seniority: string` is unconstrained. Tighten to a literal
  union when the profile becomes user-editable.
- Cross-layer name asymmetry: `Extraction.rate_eur_per_day` →
  DB `rate_eur_day` → TS `rateEurDay`. A tiny translation helper in
  `src/store/missions.ts` would make the boundary explicit.
- `MissionInput.reason` / `rawResponse` are typed as `string`, but
  `MissionDbRow` types them `string | null` and `hydrate` coalesces with
  `?? ""`. Pick one model.

### Schema validation

- `parseExtraction` JSDoc says "type guard" but throws — should be "runtime
  validator / parser".
- `String()` coercion for `duration` and `location` silently accepts
  numbers from the model. Document the leniency or add a `typeof` check.
- Required-field check uses `=== undefined` only; explicit `null` falls
  through to the per-field type check with a less-specific error.
- Schema test doesn't assert `properties` keys — a future edit could
  silently drop a property without test failure.

### scoreTick observability

- `ScoreTickResult.failed` counts BOTH `ScoringFailedError` (permanent) and
  transient errors. Split into `scoreFailed` + `transientFailed`.
- `NEURONS_PER_CALL_GUESS * 2` heuristic on `ScoringFailedError` — would be
  more accurate if `ScoringFailedError` carried the actual neuron count.
- No test for ORDER BY contract (`fetched_at ASC, id ASC`).
- No test for budget gate at the exact boundary (`budget === NEURONS_PER_CALL_GUESS`).
- No round-trip test (`runScoreTick` → `remainingBudget` reads back).
- D1 batch INSERT shape duplicates `upsertMission`. Plan deliberately
  inlined for atomicity; a `recordScoredMission(db, candidateId, extraction, source, url, title)` helper would DRY it.
- Deterministically-failing INSERT keeps a candidate `pending` forever (no
  `retry_count`). Comment exists; a real backoff column is M3+.

### Prompt and dashboard

- Rubric tier 20–49 says "lowball rate" without the threshold value;
  could interpolate `${profile.tjm.lowballBelow}€`.
- `STRICT_RETRY_NOTE` phrasing diverges slightly from base instruction
  ("extract_mission tool" vs "tool-call"). Could unify.
- Score-band thresholds (80/50/20) duplicated as numeric literals in
  `public/app.js` (`scoreClass`) and the prompt rubric. Consolidate.
- Dashboard uses `innerHTML` with `escapeHtml` + `safeUrl` — M1 carry-over
  to migrate to DOMPurify or safe DOM methods. Still M3+.
- `/api/missions` returns `rawResponse` (~200 bytes of duplicate JSON per
  row). Gate behind `?debug=1` or strip in the route.

### Source adapters (M2b)

- **Free-Work pagination ignored** — adapter fetches page 1 only (30
  newest postings). Older postings never sampled.
- **`contracts` filter looseness** documented but not post-filtered. M2c
  could decide to add a post-filter or accept the noise.
- **Per-adapter visibility in `runs.stats`** — currently `fetched` is
  aggregated across all adapters. Per-adapter counts would help diagnose
  source-specific failures.
- **RSS parser carry-forwards:** `<rsslink>` sentinel collision risk
  (vanishingly unlikely; documented), CDATA-with-`]]>` early-termination
  (XML-invalid; documented), TypeScript cast loose-ness, no test for
  CDATA + entities combined.
- **`AiResponse.tool_calls.function.name === "extract_mission"`** check
  in `scoreCandidate` is strict — silently returns null if model returns
  a different tool. Defensive but logged-then-discarded; no surfacing.

### Schema / migration

- `missions.candidate_id REFERENCES candidates(id)` has no `ON DELETE`
  action. Either add `ON DELETE CASCADE` or document the intent that
  candidates are append-only.

### Code organization

- `hydrate` (`src/store/missions.ts`) is not exported — testable only via
  DB round-trip.
- `utcMidnight` (`src/store/budget.ts`) is not exported either.
- `setTimeout(r, 10)` in the missions store idempotency test is
  potentially flaky on slow CI clocks (strict `>` so failures are loud).

### Future enhancements

- **Source-prioritized scoring** when budget is tight (e.g., score
  Free-Work before Reddit). M3+.
- **AI Gateway** for caching + monitoring + cost control. M3+.
- **Prompt-iteration audit trail** — `missions.raw_response` already
  stores the model's tool-call args; a future tool could compare runs
  across `AI_MODEL` swaps.

---

## Cloudflare free-tier constraints (the design's true north)

Verified 2026-05-27. Sized against:

- Workers AI: **10 000 Neurons/UTC day**. Llama 3.1 8B ≈ 200/call → ~50 scorings/day.
- Worker CPU: **10 ms per invocation** (I/O wait excluded).
- Subrequests: **50 per invocation**. M2b worst case ≈ 20.
- Cron triggers: **5/account**, ≤ 15 min wall clock. M1+M2a+M2b use 2.
- D1: 500 MB DB; ~5 M row-reads & 100 k row-writes/day.
- Queues / Browser Rendering: paid plan only.
- Email send: not free on CF → M3 uses Resend.

---

## How to resume (next session)

Paste something like:

> Resuming missions-free. Read `docs/HANDOFF.md` for context. M1 + M2a +
> M2b are shipped to `main` and the worker is deployed and running at
> `https://missions-free.jeremn-code.workers.dev`. I want to start \<watch
> first-24h / tune profile / M2c / M3 / a specific carry-forward fix>.

From there, brainstorm the goal (use `superpowers:brainstorming`), write a
spec (use `superpowers:writing-plans`), then dispatch implementers per the
M2a/M2b pattern (`superpowers:subagent-driven-development`).

If just monitoring the live deploy:

```bash
curl https://missions-free.jeremn-code.workers.dev/api/stats   | jq
curl https://missions-free.jeremn-code.workers.dev/api/runs    | jq '.runs[] | {tick, stats: .stats | fromjson}'
curl https://missions-free.jeremn-code.workers.dev/api/missions | jq '.missions[0:5] | .[] | {score, title, reason}'
```
