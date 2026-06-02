# missions-free — Handoff

**Last update:** 2026-06-02 (post-M3 digest email + fetch-pipeline fix)
**Working branch:** `main`
**Where to look next:** depends on the goal — see "Common entry points" below.

---

## TL;DR for a fresh session

1. **M1 + M2a + M2b + M3 are all shipped to `main`**, **106 tests pass**, working tree clean.
2. **The Worker is deployed and running on Cloudflare** at
   `https://missions-free.jeremn-code.workers.dev` — **three** crons live
   (`*/30` fetch, `*/15` score, `0 5 * * *` digest email).
3. Code is on GitHub at `git@github.com:jeremN/missions-freelance.git`
   (remote `origin`, `main` tracks).
4. **M3 (daily digest email) shipped 2026-06-02** — Resend, sends top missions
   (score≥70, real) once daily; idempotent via the `notified` column;
   `GET /api/digest/preview` renders the would-be email read-only. Secrets set:
   `RESEND_API_KEY`, `DIGEST_TO`, `DIGEST_FROM` (= `onboarding@resend.dev`).
5. **Fetch pipeline fixed 2026-06-02** — Free-Work changed to a bare-array
   response (was silently parsing 0); Reddit now hard-403s unauthenticated and
   was **disabled** (`enabled:false`, code kept). Before the fix the worker was
   producing **0 candidates** despite 500+ runs.
6. **⚠️ TOP OPEN ITEM — digest volume.** Free-Work page-1 (newest 30, all
   contracts) yields only ~1/30 that pass the prefilter's narrow skill set
   (ts/react/svelte/node/cloudflare/js). Candidates now *trickle* in. To get
   meaningful digest volume, M2c should add a Free-Work tech/keyword filter
   and/or pagination, broaden the profile skills, and/or add Hellowork.
7. **Cloudflare Access is LIVE** on the production workers.dev route (verified
   2026-06-02: unauthenticated GET → 302 to `bold-bonus-d767.cloudflareaccess.com`).
   Login = one-time PIN to the owner email. Crons unaffected (edge-only gate).

### Triage note (M3)
Digest failures are logged to Workers logs (`console.error`), **not** serialized
into `runs.stats`. When a `digest` run shows `sent:false` with `candidates>0`,
check `wrangler tail` / the logs for the cause (Resend error). `sent:true` with
`notified` still 0 on some rows = at-least-once (markNotified threw after a
successful send; they re-send next day).

---

## Deployed infrastructure (as of handoff)

| | |
|---|---|
| Worker URL | `https://missions-free.jeremn-code.workers.dev` |
| Worker version ID | `b462558e-36b7-4778-b484-60d60465951d` (2026-06-02, post-fetch-fix) |
| D1 database | `missions-free` |
| D1 UUID | `39254e3d-09ea-4e82-96f5-91096e08aff4` |
| D1 region | WEUR |
| Bindings | `DB` (D1) + `AI` (Workers AI) + `ASSETS` (public/) |
| Secrets | `RESEND_API_KEY`, `DIGEST_TO`, `DIGEST_FROM` (= `onboarding@resend.dev`) |
| Crons | `*/30` → `runFetchTick`, `*/15` → `runScoreTick`, `0 5 * * *` → `runDigestTick` |
| Active sources | `free-work` only (reddit `enabled:false` — 403s unauthenticated) |
| Migrations applied | `0001_init` + `0002_missions` (M3 added NO migration) |
| Access | **Cloudflare Access — owner email only** (team `bold-bonus-d767.cloudflareaccess.com`, aud `b6d5c44f…dc2c17`) |
| Dashboard | https://missions-free.jeremn-code.workers.dev/ (behind Access — log in via one-time PIN) |

### Access runbook (DONE 2026-06-02 — recorded for reference)

How it was enabled (dashboard UI varies — this is the path that worked):
1. Worker → **`Domains`** tab (NOT Settings → it's a top-level tab on this
   account's UI) → **Domains & Routes**.
2. On the **Worker URL · Production** row, click the **globe icon** → the access
   dropdown (default **Public**) → switch to **Restricted** (Cloudflare Access).
3. **Manage policy** → Allow / Include / Emails = `jeremie.nehlil.freelance@proton.me`,
   login **One-time PIN**.
4. Gotchas hit: needed an existing Zero Trust org; a stale app caused a
   transient `destination belongs to another application` conflict; enforcement
   took **~3 min** to propagate to the edge before GET → 302 appeared.
5. Verify: `curl -sI https://missions-free.jeremn-code.workers.dev/` → **302**
   to `bold-bonus-d767.cloudflareaccess.com`. Crons unaffected (server-side).

To redeploy after code changes:

```bash
npm run deploy            # publishes the current main
npx wrangler d1 migrations apply missions-free --remote  # only if new migration
```

---

## Repo state (as of handoff)

```
main (deployed @ version b462558e):
  → 1ce9750 docs: mark Cloudflare Access live in HANDOFF
  → 192e7d6 docs: refresh HANDOFF for post-M3 + fetch-pipeline fix
  → dd32f18 chore(reddit): disable adapter — unauthenticated .json now 403s
  → 5a1093f fix(free-work): parse bare-array response after API shape change
  → cc38651 Merge PR #1 — M3 digest email + /api/digest/preview (8 TDD commits beneath)
  → (M2b / M2a / M1 history beneath)
```

Tests: `npm test` → **106 passed** (86 prior + 19 M3 + 1 fetch-fix).
⚠️ The suite needs `wrangler login` + network (sandbox-disabled in Claude Code) —
the vitest pool opens a remote CF session for the `ai` binding. See memory note
`missions-free-tests-need-wrangler-auth`. CWD `/Users/jeremienehlil/Documents/Code/Personal/missions-free`.

---

## What's live in the code today

- Worker entry: `src/index.ts` — switches on `controller.cron`:
  - `*/30 * * * *` → `runFetchTick`
  - `*/15 * * * *` → `runScoreTick` (M2a)
  - `0 5 * * *` → `runDigestTick` (M3)
- Fetch handler routes `/api/*` → `handleApi` (incl. `/api/digest/preview`,
  which returns text/html), else falls through to ASSETS. All gated by Access.
- **One active source**: `freeWorkAdapter` (Free-Work, now a **bare JSON array** —
  adapter accepts both array + legacy Hydra shapes). `redditAdapter` exists but
  `enabled:false` (403s unauthenticated; revive via OAuth).
- **M3 digest** (`src/email/{html,digest,resend}.ts` + `src/pipeline/digestTick.ts`):
  select un-notified real missions ≥`DIGEST_MIN_SCORE` (70, `src/config.ts`),
  render escaped HTML+text, Resend send, then `markNotified` — **send-then-mark =
  at-least-once**. `recordRun` in `finally`. Injectable `email`/`now` for tests.
- **`fetchText` + RSS parser** (`src/sources/rss.ts`) still ready for M2c RSS
  sources (Hellowork, etc.).
- M2a pipeline unchanged — budget gate → SELECT pending → `scoreCandidate` →
  atomic D1 batch (INSERT mission + UPDATE candidate). `recordRun` in `finally`.

---

## Monitoring now (the pipeline is live & verified)

The first-24h watch was done on 2026-06-02 and surfaced the fetch bug (now fixed).
Current verified behavior: fetch ticks report `{fetched:~30, inserted:~0-2, errors:0, adapters:1}`.

**⚠️ The API is behind Cloudflare Access**, so unauthenticated `curl` to `/api/*`
now returns **302** to the login page — the old monitoring curls won't return JSON.
To inspect live data, either:
- open the URL in a **browser** (one-time PIN login) and hit `/api/stats`,
  `/api/runs`, `/api/missions`, `/api/digest/preview`; or
- create an Access **service token** and send `CF-Access-Client-Id` /
  `CF-Access-Client-Secret` headers with `curl`; or
- read it from the Worker logs via `npx wrangler tail`.

What to keep an eye on:
1. **Candidates flowing?** `totalCandidates` should climb slowly as stack-relevant
   FR contractor roles post on Free-Work (≈1-2 per fetch on a good page-1).
2. **Digest firing?** After the 05:00 UTC tick, look for a `digest` run; `sent:true`
   = email went out, `skipped:true` = nothing qualified that day (no email — by design).
3. **Neuron budget / AI quality** — same as before: if `runs.stats.neurons` is
   always 200 it's the `NEURONS_PER_CALL_GUESS` fallback; if French extraction is
   poor, bump `AI_MODEL` in `src/config.ts` to `@cf/meta/llama-3.3-70b-instruct-fp8-fast`
   and redeploy.

---

## M2c — the real next milestone: DIGEST VOLUME

**Why it matters now:** the pipeline works but yields a *trickle* — Free-Work is
the only live source, and its page-1 (newest 30, all contracts) matches the
narrow profile (`ts/react/svelte/node/cloudflare/js`) only ~1/30. Reddit is
disabled. So digests will be sparse until volume improves. M2c should pick from:

- **Broaden the prefilter profile** (`src/config.ts` `profile.skills`) — add
  `fullstack`, `front`/`frontend`, `web`, `vue`, `angular`, `php`, `python`…
  (cheapest lever; raises matches immediately).
- **Free-Work query tuning** — probe the API for a tech/keyword param
  (`searchKeywords`?) and/or paginate beyond page 1 (`src/sources/free-work.ts`
  currently fetches page 1 only).
- **Add Hellowork** (RSS — `parseRssItems`/`fetchText` already shipped).
- **Reddit via OAuth** (revive the disabled adapter) — lower priority (US-centric).

### Carry-over: WTTJ-Algolia question

The M2b spec §11.1 documents the WTTJ finding: their job search is backed by
**Algolia with a referer-locked public API key**. M2b dropped WTTJ to ship
Free-Work-only. M2c can resolve this or move on without WTTJ.

Three viable M2c approaches (pick during M2c brainstorm):

| Approach | What it adds | Trade-off |
|---|---|---|
| **A. Skip WTTJ; add Hellowork + Telegram instead** | 2 new adapters (RSS + Telegram Bot API) | Compatible with `parseRssItems` already shipped; clean ethics; Telegram needs a bot setup. |
| **B. Add WTTJ via Algolia + Referer spoof** | 1 WTTJ adapter | Faster to ship; rotation-risk; in the grey zone. Document explicitly. |
| **C. Hellowork only** | 1 adapter | Smallest M2c; bias toward steady incremental adds. |

The decision is essentially: "how much do we want WTTJ specifically vs.
general FR-freelance coverage?" (Note: the old assumption that sources saturate
the Neuron budget no longer holds — current candidate volume is well under it.)

---

## Common entry points for a fresh session

Pick the one that matches what you want to do:

| Goal | Start with |
|---|---|
| **Raise digest volume (M2c — the main next step)** | Broaden `profile.skills` in `src/config.ts` (quick win) and/or brainstorm Free-Work query tuning / pagination / Hellowork — write a spec+plan in `docs/superpowers/{specs,plans}/` |
| Monitor live data (behind Access) | Browser login → `/api/stats` `/api/runs` `/api/missions` `/api/digest/preview`, or `wrangler tail` — see "Monitoring now" above |
| Tune the profile (skills, hardKill, TJM) | Edit `src/config.ts` → `npm test` → `npm run deploy` |
| Swap to a stronger AI model | Edit `AI_MODEL` in `src/config.ts` → `npm run deploy` |
| Revive Reddit | OAuth flow + flip `enabled:true` in `src/sources/reddit.ts` |
| Read M3 design / plan | `docs/superpowers/specs/2026-06-01-missions-free-m3-digest-email-design.md` + `plans/2026-06-01-missions-free-m3-digest-email.md` |
| Investigate a carry-forward concern | See "Deferred" below |
| Read M2b / M2a / scanner rationale | `docs/superpowers/specs/2026-05-{29,28,27}-…` |

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

### M3 digest (carry-forward)

- **`notified` never resets on re-score** — a mission emailed once won't re-email
  even if a later re-score raises its band. Add a reset rule or `notified_score`
  watermark if re-scoring becomes meaningful.
- **Digest failures aren't in `runs.stats`** — only `console.error` (Workers logs).
  Could add an `error` field to the digest run stats for dashboard triage.
- **`/api/digest/preview` returns text/html** — deliberate exception to the
  JSON-only `/api/*` contract; revisit if the API grows content negotiation.
- **No `X-Content-Type-Options: nosniff`** on the preview route (low severity —
  behind Access). Add in a headers-hardening pass.
- **Single recipient** (`DIGEST_TO`) — no multi-recipient / preferences.
- **No in-Worker `Cf-Access-Jwt-Assertion` validation** — fine for workers.dev;
  add if a custom domain is introduced (the `aud`/JWKs are in the infra table).

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
- Cron triggers: **5/account**, ≤ 15 min wall clock. **3 used** (fetch/score/digest).
- D1: 500 MB DB; ~5 M row-reads & 100 k row-writes/day.
- Queues / Browser Rendering: paid plan only.
- Email send: not free on CF (Cloudflare Email Service = paid Workers plan) →
  M3 uses **Resend** free tier (3000/mo, 100/day; test sender `onboarding@resend.dev`
  delivers only to the Resend-account email — exactly our single recipient).
- Cloudflare Access (Zero Trust): free up to 50 users → M3 URL protection.

---

## How to resume (next session)

Paste something like:

> Resuming missions-free. Read `docs/HANDOFF.md`. M1+M2a+M2b+M3 are shipped to
> `main`, the worker is deployed at `https://missions-free.jeremn-code.workers.dev`
> (behind Cloudflare Access), digest email + fetch fix are live. I want to start
> \<raise digest volume / tune profile / revive Reddit / a carry-forward fix>.

From there, brainstorm the goal (`superpowers:brainstorming`), write spec+plan
(`superpowers:writing-plans`), then execute (`superpowers:subagent-driven-development`).

**Heads-up for whoever resumes:**
- `npm test` needs `wrangler login` + network (sandbox-disabled) — see the memory
  note. Don't mistake the pool's remote-session failure for a code bug.
- The live API is **Access-gated** — anon `curl /api/*` returns 302. Use a browser
  (PIN login) or `wrangler tail` to inspect live data.
- Don't commit to `main` unprompted — branch first (user rule).
- The single highest-leverage next move is **digest volume** (M2c) — start by
  broadening `profile.skills` in `src/config.ts`.
