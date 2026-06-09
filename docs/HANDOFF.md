# missions-free — Handoff

**Last update:** 2026-06-09 (cont.) — **PR #3 (digest link-validation) is now SQUASH-MERGED into `main` and DEPLOYED.** Prod runs **version `e4bf2141`** (full `main` @ `1d37087`) and migration **`0003_validation_fails` is applied to prod D1**. Because this deploy ships the full `main`, it also makes live everything that was previously merged-but-unverified: **Codeur RSS, the inbound `email()` handler** (inert until routing is wired), Gemma-4 scoring, and the top-N digest. **Everything in `main` is now live.**
**Working branch:** `main` @ `1d37087` (PR #3 merged; `feat/digest-link-validation` branch deleted). Working tree clean.
**Where to look next:** the "▶ Next session (2026-06-09)" block right below. (The older "▶ Session 2026-06-04" block beneath it is history.)

---

## ▶ Next session (2026-06-09) — START HERE

**State:** `main` @ `1d37087` — PR #3 squash-merged & **DEPLOYED** (prod version `e4bf2141`, 2026-06-09).
**158 tests pass offline**, `tsc --noEmit` clean. Migration `0003` applied to prod D1. Because this deploy
ships the full `main`, the earlier 2026-06-04 work (Codeur RSS + inbound `email()` handler) is **now live
too**, superseding the old `1e7fe776` (2026-06-03) deploy. The `email()` handler is deployed but **inert
until inbound email routing is wired** (see the 2026-06-04 block, step 3).

### What shipped to `main` this session
- **`787275f` fix(free-work): canonical job-mission URL so digest links don't redirect.** Root cause of
  the user's "links don't work / get redirected" report: `src/sources/free-work.ts` *constructed* posting
  URLs from a **guessed** path `/fr/tech-it/jobs/{slug}` that **301-redirected to the generic
  `/fr/tech-it/jobs` listing** (a silent soft-404 — 200 after redirect, so nothing threw). Fixed to the
  real route `https://www.free-work.com/fr/tech-it/{item.job.slug}/job-mission/{item.slug}` (verified
  200-direct against live postings). Falls back to `/fr/tech-it/job-mission/{slug}` (which the site
  301-resolves to canonical) when `item.job.slug` is absent. See memory [[missions-free-freework-url-and-feed]].
  Cross-checked the other sources: **codeur** clean (raw feed `<link>`), **linkedin** already canonical
  (`/jobs/view/{id}`; LinkedIn itself may auth-wall/expire — inherent, not ours), **reddit** disabled.

### ⭐ Shipped & deployed — PR #3: digest-time link validation (merged into `main`, live @ `e4bf2141`)
The systemic guard so the *next* such regression never reaches the inbox. Validates every digest link
the instant before it ships. **Now merged + deployed; migration `0003` applied to prod.**
- **Over-select + backfill:** the tick pulls `DIGEST_VALIDATION_POOL` (= `4 × DIGEST_TOP_N` = 20)
  un-notified real missions, validates all concurrently, ships the top-5 **healthy** ones (backfilling
  past broken links).
- **Strict validator** `src/pipeline/linkHealth.ts` (`createLinkValidator`, injectable): healthy only if a
  no-redirect `HEAD` returns `200` (HEAD→GET fallback on 405); 3xx/4xx/5xx/timeout = unhealthy. Allowlisted
  sources (`SKIP_VALIDATION_SOURCES = {"linkedin"}`) skip the network (LinkedIn auth-walls + datacenter
  egress would false-fail).
- **Give-up:** per-mission `validation_fails` counter (**migration `0003_validation_fails.sql`**) retires a
  posting (`markNotified`) after `DIGEST_GIVE_UP_AFTER` (3) consecutive failures — **even on a day nothing
  ships** — and resets whenever a link passes (tracks *link* health, not email delivery).
- **Audit:** run stats gain `pool/dropped/gaveUp`; each dropped link is `console.warn`ed with
  `{url, status, redirectedTo}`. Preserves send-then-mark (at-least-once) + never-throw semantics.
  `src/index.ts` unchanged (real validator is the default).
- Files: `migrations/0003_*.sql`, `src/config.ts` (3 consts), `src/pipeline/linkHealth.ts`,
  `src/store/missions.ts` (column + `increment/resetValidationFails`), `src/pipeline/digestTick.ts`, + tests.

### Suggested order
1. ✅ **DONE — PR #3 reviewed, squash-merged, migration `0003` applied to prod D1, Worker deployed**
   (version `e4bf2141`). Built test-first via subagent-driven execution. (For history: two findings were
   fixed in-branch before merge — a **tsc regression** from a `MissionRow` test-mock missing the new
   `validationFails` field, and a real **`recoveredIds` edge** where a link recovering the *same day* a
   send throws still resets its counter.)
2. ✅ **DONE — Codeur RSS + inbound `email()` handler are now live** (shipped with this deploy; merged
   2026-06-04 but unverified until now). The handler stays **inert until email routing is wired** (step 4).
3. **Watch the first link-validated digest go out** (05:00 UTC cron). Confirm prod behavior: the run audit
   should carry `pool/dropped/gaveUp`, each dropped link `console.warn`ed with `{url,status,redirectedTo}`,
   and the top-5 *healthy* missions shipped (backfilling past broken ones). Inspect via `wrangler tail` or
   the Access-gated `/api/runs`.
4. **Wire inbound email** to actually receive LinkedIn missions — see the 2026-06-04 block step 3 +
   `docs/EMAIL-INGEST-RUNBOOK.md` (needs a Cloudflare domain; Email Routing can't receive on `workers.dev`).
5. **Raise digest volume** — Free-Work pagination (page-1 only today), Hellowork RSS, or Reddit OAuth.

### Carry-forward (link-validation follow-ups, all optional — from the final review)
- **Sent vs given-up are indistinguishable on the row** (both `notified=1`); the split lives only in the
  run audit. Add a `dead`/reason column if you want row-level visibility.
- **Strict `200`-only rejects rare `204`/`202`** — deliberate ("clean 200 only" was the chosen design); no
  current source returns those on HEAD.
- The **plan doc still says literal `20`** for the pool (code is `4 × DIGEST_TOP_N`) — stale doc, no impact.
- Spec/plan (git-ignored scratch): `docs/superpowers/{specs,plans}/2026-06-09-digest-link-validation*`.

---

## ▶ Session 2026-06-04 (history)

**State:** `main` @ `5b350d4`, pushed to origin, working tree clean. `tsc --noEmit` **0 errors**,
**138 tests** pass fully offline (`npm test`, no wrangler/network). **Nothing deployed yet** — prod is
still the previous deploy (version `1e7fe776`, pre-Codeur, pre-email). Three now-redundant **local**
branches remain (`fix/tsc-types-hygiene`, `feat/digest-volume`, `feat/email-ingest`) — squash-merged, so
`git branch -d` won't recognize them; safe to `git branch -D` to tidy up.

### Suggested order
1. **Deploy the merged work:** `npm run deploy`. No new migration; bindings unchanged. Ships the Codeur
   source + broadened skills + word-boundary matcher + the `email()` handler. The handler is **inert until
   email routing is wired (step 3)** — deploying it now is safe.
2. **Watch Codeur flow in** (~30 min after deploy a `fetch` tick should yield `source:"codeur"`
   candidates). Inspect via `wrangler tail` or browser (Access-gated) `/api/runs` + `/api/candidates`.
   Let a digest or two go out — junk ranks low now, so broadening is low-risk.
3. **Wire inbound email** (to actually receive LinkedIn missions): `docs/EMAIL-INGEST-RUNBOOK.md`.
   Needs a **Cloudflare domain** (Email Routing can't receive on `workers.dev`) → address→Worker rule →
   Proton forward filter for `linkedin.com` → create the LinkedIn **"Contract" daily** job alert.
4. **Harden the LinkedIn parser with a real sample:** forward one real LinkedIn job-alert email, then
   tune the plain-text title/context heuristic in `src/sources/email/linkedin.ts`. (Today's parser is
   best-effort by design.)

### What shipped today (now in `main`, 3 squash commits)
`56714c7` tsc hygiene · `5cd8c66` Codeur + skill matching · `5b350d4` email ingest. All built test-first
with implementer→review subagents.

- **Thread 3 — tsc hygiene:** `tsc --noEmit` 18→0. Real `db.ts getCandidates` never-collapse fix;
  `cloudflare:test` types resolved via the `@cloudflare/vitest-pool-workers/types` subpath in tsconfig +
  a DRY `test/env.d.ts` (`declare global { namespace Cloudflare { interface Env extends <app Env> } }`);
  test-mock drift cleaned. See TL;DR #8 for detail.
- **Thread 2 — digest volume:**
  - **Codeur.com RSS adapter** (`src/sources/codeur.ts`, registered + `enabled`) — FR freelance-PROJECT
    feed `https://www.codeur.com/projects.rss` via the shipped `parseRssItems`/`fetchText`.
    ⚠️ Recon proved **Hellowork has NO public RSS/JSON** (JS-rendered; only brittle HTML scraping) — so it
    was dropped as an RSS source and deferred to the email path. Codeur is a clean public RSS.
  - **Prefilter matcher** (`src/matching/prefilter.ts`): skills now match at a **left word boundary**
    (`matchesSkillTerm`): `react`→`reactjs` still matches, but `ia` no longer hits "so**cia**l". `hardKill`
    unchanged (full two-sided boundary via `containsAsWord`).
  - **Broadened `profile.skills`** (`src/config.ts`): +fullstack/full-stack/frontend/front-end/nextjs/
    next.js/nuxt/backend/back-end/remix/astro/sveltekit/ia/llm/genai/intelligence artificielle.
- **Thread 1 — source-agnostic inbound email ingest (M4):**
  - `email()` in `src/index.ts` → `src/email/inbound.ts`: buffer raw → `PostalMime.parse` → dispatch by
    **`message.from`** (envelope sender; anti-spoof allow-list) → per-source `EmailParser` → `selectCandidates`
    (extracted to `src/pipeline/select.ts`, now shared with `fetchTick`) → `insertCandidates` → record an
    `email` run. Handler **never throws** (recordRun guarded). Dep: `postal-mime`.
  - **LinkedIn parser** (`src/sources/email/linkedin.ts`): best-effort regex `/comm/jobs/view/{id}` (+ `/jobs/view/{id}`)
    over the plain-text part; dedups ids; ignores non-job links. Registry: `src/sources/email/registry.ts`.
  - Security-reviewed: spoof domains (`linkedin.com@evil.com`, `x@linkedin.com.evil.com`) rejected; regex
    ReDoS-safe; canonical URL rebuilt from the matched id (not reflected).
  - Specs/plans (git-ignored scratch): `docs/superpowers/{specs,plans}/2026-06-03-*`.

### Carry-forward (small, optional)
- **Short-token prefilter noise:** `ia`→"iam", `astro`→"astronaute" — negligible on Codeur, but the
  LinkedIn/email path broadens scope; if noise rises, give ultra-short tokens a two-sided word boundary.
- **Unbuilt digest-volume levers:** Free-Work pagination (page-1 only today) + Reddit OAuth (disabled).
- `extractTjm` misreads Codeur project budgets ("1 000 € à 10 000 €") as lowball — harmless (deprioritize only).
- Adding another emailed source (e.g. Hellowork alerts) = a new parser in `src/sources/email/` + register
  it in `registry.ts`; no handler change.

---

## TL;DR for a fresh session

1. **⚠️ AI scoring was 100% broken from M2a until 2026-06-03 — it never produced a
   single real mission.** Root cause: a tool-call **response-shape** mismatch in
   `src/scoring/ai.ts extractToolArgs`. 106+ tests passed because `ai.test.ts`
   mocked the shape it then asserted. Now FIXED across **three** envelopes:
   native (`res.tool_calls[0]`, llama 8B/70B), OpenAI-nested (`function.name`),
   and **chat-completions** (`res.choices[0].message.tool_calls`, Gemma 4 / GLM).
2. **Scoring quality reworked (2026-06-03).** Verified in prod: a well-ranked
   spread with grounded reasons (Vue/Node 80/65 … COBOL 20 … ServiceNow/SOC 15/10).
   Three legs:
   - **Model → `@cf/google/gemma-4-26b-a4b-it`** (Gemma 4 26B A4B, MoE 4B-active).
     8B *regurgitated* the prompt's few-shot (COBOL scored 80); 70B was
     **unreliable + budget-hungry on the free tier**. Gemma scores **8/8, 0 fails**,
     reliable, ~50 neurons/call. (GLM-4.7-Flash is the documented fallback.)
   - **Prompt de-baited** (`src/scoring/prompt.ts`): separate `is_real_mission`
     from the fit `score`, removed the copy-bait example, stack-fit dominant,
     reasons must cite concrete details.
   - **Neuron accounting fixed**: `NEURONS_PER_CALL_GUESS` 1500 → **50** (real cost
     is ~10–65 neurons/call per the pricing table; the 1500 over-estimate silently
     throttled throughput to ~1 mission/day and created a "phantom budget" that
     deferred every tick — see [[missions-free-scoring-toolcall-shape]]). Plus a
     **mid-batch budget guard** in `scoreTick`.
3. **Digest is now a TOP-N ranked shortlist** (`DIGEST_TOP_N = 5`), not `score≥70`.
   `getTopUnnotifiedMissions` (un-notified + real, ORDER BY score DESC). Old
   `DIGEST_MIN_SCORE`/`DIGEST_MAX_ITEMS`/`getUnnotifiedMissions` removed.
4. **Tests run FULLY OFFLINE now** — `vitest.config.ts` sets `remoteBindings:false`
   (Cloudflare Access had broken the remote-AI pool session). **114 pass**, no
   wrangler/network/sandbox needed.
5. **✅ PR #2 (`fix/scoring-toolcall-shape` → `main`) is now MERGED** (merge commit
   `9b31bb6`; deployed @ version `1e7fe776`). The scoring fix + Gemma-4 rework + top-N
   digest all live in `main`. The old branch is fully merged (only its final HANDOFF
   doc commit was carried forward separately).
6. `docs/superpowers/` is now **git-ignored** (repo rule: superpowers scratch is
   local-only; durable decisions go in an ADR). The rework spec+plan live there
   locally (`2026-06-0{2,3}-…scoring-quality…`).
7. **Cloudflare Access still LIVE** on the workers.dev route (anon GET → 302).
   Crons unaffected (edge-only gate). Inspect live data via browser PIN login,
   `wrangler tail`, or `wrangler d1 execute … --remote`.
8. **✅ tsc + test-type hygiene FIXED** (branch `fix/tsc-types-hygiene`, off `main`).
   `npx tsc --noEmit` was 18 errors → now **0**; `npm test` still **114 pass**.
   Three fixes: (a) real `getCandidates` row-type `never`-collapse in `src/store/db.ts`;
   (b) `cloudflare:test` not resolving — added the `@cloudflare/vitest-pool-workers/types`
   subpath to tsconfig `types` + a `test/env.d.ts` that augments `Cloudflare.Env extends`
   the app `Env` (single-sourced, no drift); (c) test-mock type drift in
   `resend.test.ts`/`reddit.test.ts`. **Not yet PR'd/merged** (no push without ask).

### Triage note (scoring)
Score failures log to Workers stderr (`console.error("score-failed:", …, rawSnippet)`).
A `score` run with `failed>0, neurons=N×100` = hard `ScoringFailedError` (rawSnippet
shows the unparseable response — that's how all 3 shape bugs were caught). `failed`
with the candidate staying `pending` = transient (AI binding error) → retries next tick.
The neuron value in `runs.stats` is the **guess (50)**-based estimate unless the model
reports `usage.neurons` (Gemma does not), so it over/under-states real spend somewhat.

---

## Deployed infrastructure (as of handoff)

| | |
|---|---|
| Worker URL | `https://missions-free.jeremn-code.workers.dev` |
| Worker version ID | `e4bf2141-47dd-4c19-9556-ffd3e1bcf4f3` (2026-06-09, link-validation + Codeur + email handler + Gemma 4) |
| AI model | `@cf/google/gemma-4-26b-a4b-it` (`AI_MODEL` in `src/config.ts`) |
| D1 database | `missions-free` |
| D1 UUID | `39254e3d-09ea-4e82-96f5-91096e08aff4` |
| D1 region | WEUR |
| Bindings | `DB` (D1) + `AI` (Workers AI) + `ASSETS` (public/) |
| Secrets | `RESEND_API_KEY`, `DIGEST_TO`, `DIGEST_FROM` (= `onboarding@resend.dev`) |
| Crons | `*/30` → `runFetchTick`, `*/15` → `runScoreTick`, `0 5 * * *` → `runDigestTick` |
| Active sources | `free-work` + `codeur` (both `enabled:true`; reddit `enabled:false` — 403s unauthenticated) |
| Migrations applied | prod: `0001_init` + `0002_missions` + **`0003_validation_fails`** (applied 2026-06-09, `--remote`) |
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
main — PR #2 MERGED (merge 9b31bb6), deployed @ version 1e7fe776. The scoring/Gemma-4/
digest work that was on fix/scoring-toolcall-shape is now in main:
  → 54ff2b7 docs: refresh HANDOFF after scoring fix + Gemma-4 quality rework
  → 386683c fix(scoring): parse the chat-completions tool-call envelope (Gemma/GLM)
  → ea8fbe3 feat(scoring): switch to gemma-4 MoE and fix the neuron-cost estimate
  → ee2ce70 fix(scoring): cap per-tick neuron spend mid-batch
  → 5623a35 feat(digest): email a ranked top-N shortlist instead of a fixed threshold
  → 86c2eae feat(store): add getTopUnnotifiedMissions for ranked digest selection
  → 50bd49b feat(scoring): rewrite prompt to separate is_real from fit, stop regurgitation
  → 137209e feat(scoring): use llama-3.3-70b… (SUPERSEDED by ea8fbe3 — model is Gemma now)
  → fa8f404 docs: refresh README and stop tracking superpowers scratch
  → b1c1929 fix(scoring): parse native Workers AI tool-call shape
  → e263d79 test(config): disable remote bindings so pool starts behind Access
```

Tests: `npm test` → **114 passed**, fully **OFFLINE** (`vitest.config.ts` has
`remoteBindings:false`) — no `wrangler login` / network / sandbox-disable needed.
**PR #2 is MERGED into `main`.** `tsc --noEmit` is now **0 errors** (was 18 — fixed on
branch `fix/tsc-types-hygiene`, see TL;DR #8; not yet merged). CWD
`/Users/jeremienehlil/Documents/Code/Personal/missions-free`.

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

## Open threads for next session (decided 2026-06-03)

> **STATUS: #1 (LinkedIn email-ingest) and #2 (digest volume) are now BUILT** — see
> "Session 2026-06-03 (cont.)" at the top. The notes below are the original research/rationale,
> kept for context. #2's Free-Work pagination + Reddit-OAuth sub-options remain unbuilt.

The scoring pipeline now WORKS and ranks well. Pick up any of these.

### 1. ⭐ LinkedIn missions via an email-ingest adapter (the active thread)

**Goal:** get LinkedIn freelance missions into the pipeline. **Decided approach:
a source-agnostic INBOUND-email adapter** — Cloudflare **Email Routing** → an
`email()` handler in the Worker → parse the alert email → insert a candidate
(then scored by Gemma like any other source). User chose this ("email → Worker").

**Research already done — do NOT redo it:**
- **The "original source" the user remembered = [freelancemention.fr](https://freelancemention.fr/)**
  — a PAID service (€12 Lite / €49 Premium per month) whose AI scrapes LinkedIn for
  freelance missions and **emails (Lite) or webhooks (Premium)** the matches. It is
  essentially a paid version of THIS project.
- **How FreelanceMention (and any LinkedIn scraper) works:** LinkedIn's internal
  **Voyager API** (private JSON API) with authenticated `li_at`+`JSESSIONID` cookies +
  rotating residential proxies + an LLM to classify. **Not replicable on free-tier
  Workers** (stateless, datacenter egress IPs LinkedIn blocks, no persistent auth
  session). This is the paid moat; the original spec already deferred direct LinkedIn to
  "M4 / paid / external runner".
- **The FREE path (chosen):** LinkedIn's OWN native **Job Alerts** — on LinkedIn job
  search set Job type = **Contract** + keywords + location → "Create search alert" → free
  daily emails. ToS-clean (first-party, your own alerts). **Limitation:** covers only
  LinkedIn's formal **job board** (Contract listings), NOT the "hidden" feed-post missions
  (recruiters posting as updates) that FreelanceMention specialises in — those have **no
  free path**.
- **Architecture win:** the email-ingest adapter is **source-agnostic** — build it once,
  feed it LinkedIn's free Contract alerts now; if hidden-feed coverage is ever worth
  €12/mo, point the SAME inbox at FreelanceMention (Lite=email, Premium=webhook) with zero
  code change.

**Next step:** brainstorm/design the adapter. Notes for the design: existing adapters are
PULL/cron (`fetchTick` → `enabledAdapters()`); this one is PUSH/inbound, so it's a NEW
ingestion path, not a `SourceAdapter`. Needs: Email Routing + `wrangler.jsonc` config, an
`email()` export in `src/index.ts`, an email→candidate parser (title/body/url from the
alert), and dedup vs existing candidates (`UNIQUE(source, external_id)`). Load the
**`cloudflare-email-service`** skill. Email Routing is FREE on the free plan.

### 2. Digest volume (free sources)

Now that scoring ranks correctly, broadening sources is SAFE (junk just ranks low):
- **Add Hellowork** (RSS — `parseRssItems`/`fetchText` already shipped). Cleanest add.
- **Free-Work query tuning** — paginate beyond page 1 / probe a keyword param
  (`src/sources/free-work.ts` fetches page 1 only).
- **Broaden `profile.skills`** (`src/config.ts`) — but the prefilter is a SUBSTRING
  OR-match, so short tokens (`js`,`ts`,`vue`) over-match ("json","tests","revue"). Add
  longer safe terms (`vuejs`,`fullstack`,`full-stack`,`frontend`,`front-end`,`nextjs`).
  This is the USER's domain (their job prefs) — confirm terms with them.
- **Reddit via OAuth** (revive the disabled adapter) — lower priority (US-centric).

### 3. Parked quick wins (hygiene + tuning) — small, independent, optional

- **Field extraction** — Gemma often returns `rate/remote = unknown`; a prompt nudge ("use
  unknown only if truly absent; don't guess") may tighten it (low risk; many are genuinely
  absent in postings).
- **Budget margin** — lower `DAILY_NEURON_BUDGET` 10000 → 9000 (only matters on the **Paid**
  plan; on **Free**, overage just ERRORS — no billing, ever; the strongest cost protection
  is staying on Free with no card). Optionally add a dashboard usage alert.
- ~~**Fix the 18 `tsc --noEmit` errors**~~ **✅ DONE** (branch `fix/tsc-types-hygiene`, off
  `main`, not yet merged). tsc 18 → **0**, tests still 114. (a) `cloudflare:test` — added the
  `@cloudflare/vitest-pool-workers/types` subpath to tsconfig `types`; the module decl lives
  behind that subpath export, not the package's main entry. The downstream `env`-untyped
  cascade (incl. `fetchTick.test.ts:145`) was auto-fixed by a `test/env.d.ts` that does
  `declare global { namespace Cloudflare { interface Env extends <app Env> } }` (single-sourced
  from `src/types/env.ts`, no field duplication). (b) `src/store/db.ts` `getCandidates` row type
  → `Omit<CandidateRow,"lowball"> & {lowball:number}` (type-only; runtime unchanged). (c) test-
  mock drift in `resend.test.ts` (typed the fetch mock's params) + `reddit.test.ts` (FetchJson/
  FetchText casts on the disabled adapter's mocks).

### Carry-over: WTTJ-Algolia (from M2b spec §11.1)
WTTJ job search is Algolia behind a referer-locked public key. Dropped in M2b; resolve or
skip during a volume push. **Note:** the old "sources saturate the Neuron budget" worry is
DEAD — real cost is ~10–65 neurons/call (pricing table), the 10k/day budget fits hundreds.

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

> Resuming missions-free. Read `docs/HANDOFF.md` (start at "▶ Tomorrow (2026-06-04)"). The tsc
> hygiene + Codeur RSS source + inbound email-ingest threads are all **MERGED & PUSHED to `main`**
> (@ `5b350d4`, tsc 0, 138 tests offline) but **NOT yet deployed**. I want to \<deploy + watch Codeur /
> wire the email runbook / harden the LinkedIn parser from a real sample>.

From there: most of the build is done — see the "▶ Tomorrow" suggested order. For NEW feature work
brainstorm the goal (`superpowers:brainstorming`) → spec+plan (`superpowers:writing-plans`) →
execute (`superpowers:subagent-driven-development`). For the email runbook, the
`cloudflare-email-service` skill has the routing details.

**Operate / inspect live data (the worker is Access-gated):** browser PIN login to
`/api/*`, or `wrangler tail`, or
`wrangler d1 execute missions-free --remote --command "SELECT …"`. Score failures log the
raw model response to stderr (that's how all THREE tool-call shape bugs were caught — see
[[missions-free-scoring-toolcall-shape]]). If a day's neuron budget shows stuck at 0, it's
**phantom** `runs.stats.neurons` from an old over-estimate — clear/zero the inflated
`score`-run rows; real cost is ~tens of neurons/call.

**First action on resume:** everything is merged & pushed to `main`. The natural first move is
**`npm run deploy`** (ships Codeur + email handler; handler stays inert until the runbook is done) —
see the "▶ Tomorrow" suggested order at the top. Optionally `git branch -D` the 3 stale local branches.

**Heads-up for whoever resumes:**
- `npm test` runs **FULLY OFFLINE** (`vitest.config.ts` → `remoteBindings:false`) — no
  `wrangler login` / network / sandbox-disable needed. See [[missions-free-tests-need-wrangler-auth]].
- The live API is **Access-gated** — anon `curl /api/*` returns 302. Use a browser
  (PIN login) or `wrangler tail` to inspect live data.
- Don't commit to `main` unprompted — branch first (user rule).
- The single highest-leverage next move is **digest volume** (M2c) — start by
  broadening `profile.skills` in `src/config.ts`.
