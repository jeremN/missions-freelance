# missions-free M2b — Source Adapters Expansion — Design Spec

**Date:** 2026-05-29
**Status:** Approved (pending spec review)
**Predecessors:** M1 + M2a (both shipped) — see
`docs/superpowers/specs/2026-05-27-missions-free-scanner-design.md` (original
scanner spec) and `docs/superpowers/specs/2026-05-28-missions-free-m2a-ai-scoring-design.md`
(M2a, named M2b's candidate sources in §1).
**Author:** Jérémie (with Claude)

M1 brought one source (Reddit `r/forhire`). M2a built the judgment layer
(Workers AI scoring) on top. The pipeline is now end-to-end functional but
**single-source-bottlenecked**: ~5–15 `[Hiring]` posts a day on r/forhire is
not enough volume to keep the 10 000 Neuron/day budget meaningfully busy, and
it under-samples French senior freelance work specifically.

This spec adds **two source adapters — Free-Work and Welcome to the Jungle
(WTTJ)** — alongside the existing Reddit adapter, with the goal of maximizing
the number of *relevant* candidates surfaced per day for an FR senior
TypeScript / React / Node freelancer.

---

## 1. Goal & scope

**Primary goal:** Volume. Maximize the count of relevant (senior, freelance,
FR-language or FR-located, in-stack) candidates that reach the score tick each
day, without inflating noise to the point of saturating the Neuron budget
with bad scorings.

**In scope (as approved at brainstorm; WTTJ dropped during recon — see §11.1):**

- Add `free-work` adapter targeting Free-Work's freelance listings.
- ~~Add `wttj` adapter targeting WTTJ's freelance listings, France-only.~~
  **Dropped during Task 3 recon (2026-05-29).** See §11.1 — moved to M2c.
- Extend `src/sources/http.ts` with a sibling `fetchText` helper (RSS / HTML
  bodies) alongside the existing `fetchJson`. Same retry / backoff / ETag
  semantics.
- Add `src/sources/rss.ts` — a small, dependency-free RSS-2.0 / Atom parser
  using Cloudflare's built-in `HTMLRewriter`.
- Wire both new adapters into `src/sources/registry.ts` so `runFetchTick`
  picks them up automatically.
- Update `src/pipeline/fetchTick.ts` to pass both `fetchJson` and `fetchText`
  into `AdapterCtx`.

**Explicitly out of scope (carried forward):**

- **Cross-source dedup.** A mission posted on both Free-Work and WTTJ
  produces two candidates and (eventually) two AI scorings. Accepted as
  known waste — see §11.
- **LinkedIn** — still M4 (auth, ToS, off the free critical path).
- **Hellowork, Telegram, other FR boards** — punted to M2c.
- **Schema changes.** No new columns, no new tables, no new migration.
- **Runtime dependencies.** No new `npm` deps. Parser uses `HTMLRewriter`.
- **Source-prioritized scoring.** scoreTick keeps oldest-first batching; if
  the day's budget is tight, Free-Work missions don't get priority over
  Reddit ones. Refinement is M3+.
- **Prefilter tightening.** Even if M2b inflates daily candidate volume to
  60+ (with a 50-budget cap), the M2a defer-to-next-UTC-day behavior stands.
- **Dashboard changes.** The dashboard already renders any candidate /
  mission regardless of `source`. The Missions section will start showing
  `free-work` and `wttj` cards automatically once the adapters land — no
  HTML/JS changes required.
- **Real-network smoke tests in CI.** Recon happens during implementation
  with `curl` + fixture capture; CI stays fully offline.

---

## 2. Cloudflare constraints (north star, unchanged)

Verified 2026-05-27. M2b sits comfortably inside every limit:

| Resource | Free-tier limit | Consequence for M2b |
|---|---|---|
| Workers AI | 10 000 Neurons/UTC day; ~200/call → ~50 scorings/day | Adding sources pushes more candidates into the prefilter. Expected post-prefilter volume: 20–60/day (vs M2a's ~5–15). Days where volume exceeds 50 → M2a's deferral path absorbs the overflow. **No change to AI code.** |
| Worker CPU | 10 ms per invocation (I/O excluded) | Adapters are I/O-dominated. RSS parsing on a ~5 KB feed is sub-ms. |
| Subrequests | 50 per invocation | `runFetchTick` worst case: 3 adapter fetches × (1 initial + 3 retries) = 12, plus 3 `getSourceState` reads, 3 `setSourceState` writes, 1 `insertCandidates`, 1 `recordRun` = **20** subrequests. Comfortable. |
| Cron triggers | 5/account | Still 2 in use (`*/30 fetch`, `*/15 score`). M2b adds none. |
| D1 | 500 MB DB; ~5 M reads / 100 k writes per day | M2b inserts more candidates and updates `source_state` per adapter; sub-thousand writes/day. Negligible. |
| Email send | Not free on CF | Still M3 (Resend). |

---

## 3. Architecture (slots into the existing pipeline)

The cron timing, the `candidates` / `missions` tables, the budget gate, and
the scoreTick pipeline are all untouched. Only the M1 fetch leg gains adapters.

```
                       ┌─────────────────────────┐
   */30 cron ─────────▶│   runFetchTick(env)     │
                       │   for adapter of [      │
                       │     reddit  (existing), │──▶  inserts new candidates
                       │     freeWork  (M2b),    │     (status='pending')
                       │     wttj    (M2b),      │     de-duped per source via
                       │   ] { fetch → prefilter}│     UNIQUE(source, external_id)
                       └─────────────────────────┘

   M2a's runScoreTick is unchanged. It now sees more pending candidates per
   day; the 10k Neuron/day budget gates the scoring rate at ~50/day as before.
```

`fetchTick` continues to loop adapters **sequentially** with per-adapter
try/catch isolation. The existing `try/finally` around `recordRun` keeps the
audit trail intact even if all three adapters throw.

### 3.1 Responsibility split (the M2b design's central invariant)

| Layer | Owns |
|---|---|
| Adapter | **Source-shape filtering** — "what makes this source meaningful at all". Reddit's `[Hiring]` prefix; WTTJ's `?contract=freelance&location=France` URL parameters; Free-Work's freelance-only listing endpoint. |
| `prefilter` (M1) | **User-profile filtering** — skills, `hardKill` terms, TJM extraction & lowball detection. Single source of truth for profile rules. |
| `scoreCandidate` (M2a) | **Semantic understanding** — `is_real_mission`, structured extraction, 0–100 relevance score, one-line reason. |
| Dashboard | Display, filter-by-title UI. |

Consequence: a new adapter **never imports `profile`**, **never references
`lowballBelow`**, and **never knows about the Neuron budget**. It only knows
how to talk to one upstream API and normalize its output into a `RawMission`.

This means the adapter interface stays small forever — adding adapter #N+1
in M2c never requires touching the prefilter or the scorer.

---

## 4. Components

### 4.1 `src/sources/http.ts` — extend with `fetchText`

Today exposes `createFetchJson(deps) → FetchJson`. M2b adds a sibling
`createFetchText(deps) → FetchText` with the **same retry / ETag /
Retry-After / backoff semantics**, differing only in:

- `Accept: text/xml, application/xml, text/html, */*` instead of
  `application/json`.
- `await res.text()` instead of `await res.json()`.

A single factory `createFetchClients(deps) → { fetchJson, fetchText }` is
exposed for `fetchTick` and replaces the existing `createFetchJson` export.
The internal retry/backoff logic is extracted into one `withRetry` helper
used by both clients (≈ 30 lines extracted; reduces duplication without
growing the public API). Both internal callers — `src/pipeline/fetchTick.ts`
and `test/sources/http.test.ts` — switch from `const fetchJson =
createFetchJson()` to `const { fetchJson } = createFetchClients()`, which is
a one-line change at each call site and preserves all existing `fetchJson`
test coverage.

```ts
export type FetchText = (
  url: string,
  opts?: { etag?: string | null; lastModified?: string | null },
) => Promise<FetchResult<string>>;

export interface FetchClients {
  fetchJson: FetchJson;
  fetchText: FetchText;
}
export function createFetchClients(deps?: FetchJsonDeps): FetchClients;
```

`FetchResult<T>`'s existing shape (`{ data: T | null, etag?, lastModified?,
notModified: boolean }`) covers strings just as well as parsed JSON. No type
change needed.

### 4.2 `src/sources/rss.ts` — new file

A focused, dependency-free RSS-2.0 / Atom parser using Cloudflare's
`HTMLRewriter`. Roughly 60 lines.

```ts
export interface RssItem {
  id: string;            // RSS <guid> or Atom <id>, else <link>
  title: string;
  link: string;
  description: string;   // <description> (RSS) or <summary>/<content> (Atom)
  pubDate?: string;      // RFC822 or ISO8601 — passed through verbatim
}

/** Returns [] on malformed or empty XML — never throws. */
export function parseRssItems(xml: string): RssItem[];
```

Design constraints:

- **Never throws.** Malformed XML, missing elements, or empty bodies return `[]`.
- **Drops items with missing required fields** (`id || link`, `title`) — same
  loose-validation philosophy as `redditAdapter`'s `validPost`.
- Handles both RSS-2.0 (`<rss><channel><item>...`) and Atom
  (`<feed><entry>...`).
- Decodes `&amp;`/`&lt;`/`&gt;`/`&quot;`/`&#39;` entities in text content;
  doesn't attempt full HTML entity decoding.
- No CDATA-section-specific logic — `HTMLRewriter` handles it.

### 4.3 `src/sources/free-work.ts` — new adapter

```
id: "free-work"
enabled: true
fetch(ctx):
  1. body = await ctx.fetchText(FREE_WORK_URL, { etag: ctx.state?.etag })
  2. if body.notModified → return { missions: [] }
  3. items = parseRssItems(body.data)
  4. return {
       missions: items.map(i => ({
         source: "free-work",
         externalId: i.id,
         url: i.link,
         title: i.title,
         body: i.description,
         postedAt: i.pubDate,
       })),
       state: { etag: body.etag, lastModified: body.lastModified },
     }
```

`FREE_WORK_URL` is committed as a single top-of-file constant. Recon during
Task 2 pins the exact URL — preferring RSS, falling back to a JSON listing
endpoint if RSS isn't available (in which case the adapter switches to
`ctx.fetchJson` with no other shape change).

No body-level filtering at the adapter level: Free-Work's freelance listing
endpoint is freelance-only by definition. Geography defaults to France via
the URL.

### 4.4 `src/sources/wttj.ts` — new adapter

Same shape as `free-work.ts`. WTTJ exposes a public job-search endpoint used
by their search UI; Task 3 recon pins the exact URL with `contract_type` and
`location` parameters baked in.

Two possible fetch shapes depending on what recon finds:

- **JSON search API:** use `ctx.fetchJson<WttjSearchResponse>`; map results
  into `RawMission`.
- **HTML search results:** use `ctx.fetchText` + a tiny HTMLRewriter handler
  scoped to one CSS-selector pattern. If WTTJ also exposes RSS, use RSS via
  `parseRssItems` instead.

The adapter file size is bounded by source structure: ≤ 80 lines either way.

WTTJ-specific filters at adapter level:

- Contract type = freelance only (URL parameter, OR post-fetch filter on a
  `contract_type` field, OR both).
- Location = France only (URL parameter).

### 4.5 `src/sources/registry.ts` — update

```ts
import { redditAdapter } from "./reddit";
import { freeWorkAdapter } from "./free-work";
import { wttjAdapter } from "./wttj";
import type { SourceAdapter } from "./types";

export const adapters: SourceAdapter[] = [
  redditAdapter,
  freeWorkAdapter,
  wttjAdapter,
];
```

### 4.6 `src/pipeline/fetchTick.ts` — one small change

`createFetchJson()` → `createFetchClients()`. Both clients land in
`AdapterCtx`. No other logic change.

```ts
// before
const fetchJson = createFetchJson();
const ctx = { state: prior, fetchJson };

// after
const { fetchJson, fetchText } = createFetchClients();
const ctx = { state: prior, fetchJson, fetchText };
```

### 4.7 `src/sources/types.ts` — interface extension

```ts
export interface AdapterCtx {
  state: SourceState | null;
  fetchJson: FetchJson;
  fetchText: FetchText;     // NEW
}
```

Existing `redditAdapter` doesn't use `fetchText` — TypeScript's structural
typing means it doesn't need to change.

---

## 5. Data flow

Identical to today's:

```
adapter.fetch(ctx)
  └─→ RawMission[]
       └─→ prefilter(raw, profile) → { passed: true, tjm, lowball } | { passed: false }
            └─→ if passed: push to survivors
                 └─→ at loop end: insertCandidates(env.DB, survivors)
                      └─→ candidates table (status='pending')
                           └─→ M2a scoreTick picks them up oldest-first
```

Three sources instead of one. Per-source state is persisted via
`setSourceState`/`getSourceState` — the existing `source_state` row keyed by
adapter `id` handles ETag / Last-Modified / cursor for each.

`runFetchTick`'s return type stays `{ fetched, inserted, errors }`. The stats
recorded into `runs` include `adapters: 3` instead of `adapters: 1`.

---

## 6. Error handling

Inherits M1's adapter isolation:

| Failure mode | Behavior |
|---|---|
| Adapter throws (network, HTTP error, parse error) | Caught by `fetchTick`'s per-adapter try/catch. `errors += 1`. Other adapters continue. Tick still records run in `finally`. |
| RSS parse failure inside adapter | `parseRssItems` returns `[]`. Adapter returns `{ missions: [] }`. Logged via `console.error` in the adapter. Not counted as a tick error (parse-degraded ≠ tick-failed). |
| Single malformed item inside RSS | Dropped silently by `parseRssItems` (loose validation). Sibling items pass through. |
| 304 Not Modified | `fetchText` returns `{ data: null, notModified: true }`. Adapter returns `{ missions: [] }`. **Stored ETag is preserved** (see `fetchTick.ts` merge logic). |
| 429 / 5xx / 403 | `fetchText` retries with Retry-After / exponential backoff, capped at 20 s. After max retries, throws — caught by per-adapter try/catch. |
| `recordRun` itself throws | Bubbles up. M2a's `finally` semantics in `scoreTick` aren't relevant here; M1's `finally` already wraps recordRun. |

**No new error class.** `ScoringFailedError` (M2a) is unrelated. Adapter
exceptions are plain `Error`s; the M1 catch site doesn't need to
type-discriminate.

---

## 7. Configuration

No config additions. Adapter URLs are hardcoded constants at the top of each
adapter file — same pattern as `redditAdapter`'s `FEED_URL`. This is
deliberate: the URL is part of the adapter's identity. Changing it during
runtime would invalidate the per-source ETag state.

The user-profile in `src/config.ts` is unchanged. The two new adapters
inherit the same `profile.skills` / `profile.hardKill` / `profile.tjm` via
the central `prefilter`.

---

## 8. Module layout (new + modified files)

```
src/sources/
  http.ts               # MODIFY: add createFetchClients, fetchText, withRetry refactor
  rss.ts                # NEW: parseRssItems
  free-work.ts          # NEW: freeWorkAdapter
  wttj.ts               # NEW: wttjAdapter
  reddit.ts             # UNCHANGED
  registry.ts           # MODIFY: register the two new adapters
  types.ts              # MODIFY: extend AdapterCtx with fetchText

src/pipeline/fetchTick.ts  # MODIFY: use createFetchClients

test/sources/
  fixtures/
    free-work-sample.rss.xml   # NEW: captured during Task 2 recon
    wttj-sample.json           # NEW: captured during Task 3 recon
                               # (or wttj-sample.html if HTML fallback)
  http.test.ts          # MODIFY: + fetchText tests
  rss.test.ts           # NEW: parseRssItems tests
  free-work.test.ts     # NEW: adapter unit tests
  wttj.test.ts          # NEW: adapter unit tests

test/pipeline/fetchTick.test.ts  # MODIFY: 3-adapter integration scenario
```

No new dependencies in `package.json`. No new migration. No `worker-configuration.d.ts` regen needed (no new bindings).

---

## 9. Testing strategy

Mirrors M2a exactly. **No real network in CI.**

| Test file | Coverage |
|---|---|
| `test/sources/http.test.ts` | `fetchText` happy path (200 + body), 304 (returns `{data: null, notModified: true}`), retry on 429 with Retry-After, exponential backoff on 503. Fakes `fetch` via the existing `deps.fetchImpl` parameter. |
| `test/sources/rss.test.ts` | RSS-2.0 fixture → expected items; Atom fixture → expected items; malformed XML → `[]`; item missing `title` → dropped, siblings preserved; CDATA in `<description>` → unwrapped. |
| `test/sources/free-work.test.ts` | Adapter returns mapped missions from a parsed feed; respects `ctx.state.etag` on input; 304 returns `{ missions: [] }`; parse error returns `{ missions: [] }`; passes through `etag` / `lastModified` from response to `state`. |
| `test/sources/wttj.test.ts` | Analogous to free-work; the test layer is the same regardless of whether the underlying fetch is `fetchJson` or `fetchText`. |
| `test/pipeline/fetchTick.test.ts` (modified) | 3 adapters running; one throws → others still produce; `errors === 1`; recorded run stats include all three. |

Fixtures are real captured responses (one-time `curl` capture during
implementation, redacted if needed), checked into the repo under
`test/sources/fixtures/`. They are NOT regenerated automatically — they're
intentionally pinned so test failures surface adapter logic regressions, not
upstream API changes.

Expected total test count after M2b: **~85–90** (current 71 + ~14–18).

---

## 10. Acceptance criteria

1. `npm test` → 85+ tests passing on `main`.
2. `runFetchTick` invokes all 3 enabled adapters in sequence; failure of one
   logs and continues; final run record contains aggregated stats.
3. Each adapter, called with a fake `fetchText`/`fetchJson` returning a
   captured fixture, produces the expected list of `RawMission`s.
4. The integration test in `test/pipeline/fetchTick.test.ts` covers all three
   adapters running together, one of them throwing.
5. **Manual smoke (NOT in CI)** — during Task 4 of the implementation plan:
   `npx wrangler dev` + `curl /__scheduled?cron=*/30+*+*+*+*` produces at
   least one `free-work` and one `wttj` row in the `candidates` table within
   30 seconds, OR the adapter logs a real, debuggable reason for an empty
   result.
6. The dashboard, with no code change, renders `free-work` and `wttj` cards
   with the same UI as Reddit ones (verified manually post-deploy).

---

## 11. Known omissions, risks, and carry-forward to M2c+

### 11.1 WTTJ — dropped from M2b after recon (2026-05-29)

WTTJ has no public RSS or JSON jobs API. Their search UI is backed entirely
by **Algolia**, with a referer-locked public API key embedded in
`window.env`:

- `ALGOLIA_APPLICATION_ID: "CSEKHVMS53"`
- `ALGOLIA_API_KEY_CLIENT: "4bd8f6215d0cc52b26430765769e65a0"`
- Index: `wttj_jobs_production_fr` (~100 k jobs total)

The Algolia endpoint returns `"Method not allowed with this referer"` unless
`Referer` matches `*.welcometothejungle.com`. The `api.welcometothejungle.com`
search endpoint either 404s or returns 500 without a session cookie.

This crosses M2b's HALT-on-auth guardrail in two ways:
1. The referer requirement is an out-of-band auth signal (WTTJ doesn't intend
   this endpoint for non-browser clients).
2. The public Algolia key is rotatable — a silent 403 in production is a
   real failure mode.

**Decision:** drop WTTJ from M2b. Free-Work alone (~6 800 contractor postings)
already saturates the M2a Neuron budget, so the "volume" goal is met.

**Carry forward to M2c:** any WTTJ adapter needs to either (a) accept the
Algolia + referer-spoof approach with explicit documentation and a
monitoring story for the key, OR (b) wait for WTTJ to expose an official
job-seeker API. M2c gets its own brainstorm + spec when revisited.



| Item | Status | Future |
|---|---|---|
| Cross-source dedup | Out of scope. ~20% overlap → ~10 wasted scorings/day, accepted. | Possible LLM-derived `dedup_key` field in M3+. |
| Source-prioritized scoring | scoreTick keeps oldest-first. | Refinement candidate for M3. |
| Source-specific rate caps | Single `MAX_RETRY_DELAY_MS = 20_000` shared across all adapters. | Per-source override possible if a source returns persistent 429s. |
| Prefilter signature for FR vs EN posts | Existing `skills`/`hardKill` matching is case-insensitive substring. WTTJ posts may use English. | Verify in Task 4 smoke; tune `skills` / `hardKill` lists if needed. |
| Adapter ToS for Free-Work / WTTJ | One request every 30 minutes per source. Below any reasonable rate-limit policy. User-Agent identifies the project. | If a source bans the User-Agent, swap to a more neutral one; not a blocker today. |
| HTMLRewriter quirks on XML | Cloudflare ships `HTMLRewriter` for HTML; XML support is undocumented for niche namespaced elements. | Task 1 verifies on RSS-2.0 + Atom fixtures. Fallback: a 30-line manual XML scanner (regex-based, scoped only to RSS/Atom shapes — not a general parser). |
| Empty RSS feeds with valid 200 | `parseRssItems` returns `[]`; adapter returns no missions; not flagged as an error. | Acceptable: empty is a valid state. |
| Cross-source date normalization | RSS pubDate is RFC822; Atom is ISO8601; Reddit is Unix epoch. Each adapter converts to ISO8601 before producing `RawMission.postedAt`. | Already covered by each adapter's mapper — no shared utility needed. |

---

## 12. Phasing (preview — full plan in the implementation plan doc)

1. **Task 0** — `fetchText` + `createFetchClients` extension in `src/sources/http.ts`. `AdapterCtx` interface extension. `fetchTick` consumer update. Tests: extend `http.test.ts` only. (Foundation.)
2. **Task 1** — `parseRssItems` in `src/sources/rss.ts` with both RSS-2.0 and Atom fixtures. (Pure helper, easy to TDD.)
3. **Task 2** — `freeWorkAdapter`. Recon → fixture capture → adapter → tests. Commit fixture.
4. **Task 3** — `wttjAdapter`. Same flow. JSON or HTML fallback depending on what recon finds.
5. **Task 4** — Registry update + `fetchTick.test.ts` integration extension. Manual smoke against real sources (NOT in CI). Documentation update in README ("Sources" section).

Each task ships an `--amend`-safe single commit with a conventional-commits
subject line. The implementation plan (next doc) will inline full task text.

---

## 13. Predecessor cross-references

- `docs/superpowers/specs/2026-05-27-missions-free-scanner-design.md` —
  original scanner spec; named WTTJ and Free-Work as M2 candidate sources
  (split here to M2b).
- `docs/superpowers/specs/2026-05-28-missions-free-m2a-ai-scoring-design.md`
  §1 — explicitly punted "Free-Work, WTTJ, Hellowork, Telegram" to M2b.
- `docs/superpowers/plans/2026-05-28-missions-free-m2a-ai-scoring.md` —
  M2a implementation plan; M2b follows the same task-template + two-stage
  review structure (`superpowers:subagent-driven-development`).
- `docs/HANDOFF.md` (post-M2a refresh) — current carry-forward list
  references M2b as the natural next milestone.

---

## 14. Self-review checklist

After writing this spec:

- §1 scope is volume-oriented and committed to exactly 2 sources. No
  silent re-scoping has crept in.
- §2 constraint table re-verifies subrequest math for the worst case
  (14 / 50).
- §3.1 responsibility split is the central invariant — if adapter code ever
  needs to import `profile` or know about Neurons, the spec was wrong.
- §4 components map 1:1 to §12 phasing tasks; nothing in §4 is unaccounted-for
  in the task list.
- §5 data flow shows no schema change.
- §6 error matrix covers network, parse, 304, 429/5xx, malformed-item.
- §9 testing strategy keeps CI offline and pins fixtures intentionally.
- §10 acceptance criteria includes a manual smoke step explicitly marked
  NOT-in-CI, so future readers don't think it should be automated.
- §11 carry-forward list calls out cross-source dedup as accepted waste with
  the ~10 scorings/day cost named.
