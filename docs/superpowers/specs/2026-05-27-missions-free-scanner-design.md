# missions-free — Design Spec

**Date:** 2026-05-27
**Status:** Approved (pending spec review)
**Author:** Jérémie (with Claude)

A personal, free, always-on radar for freelance missions matching a defined
profile. Inspired by [freelancemention.fr](https://app.freelancemention.fr/)
(AI scans sources, filters noise, alerts on real missions) and by the prior
`scrapouille` disruption-scanner (scrape → store → score → notify → dashboard,
running for free on a cron). This rebuild keeps that pipeline shape but is
**Cloudflare-native, TypeScript**, and runs entirely on free tiers for its core.

---

## 1. Goal & scope

Continuously discover freelance missions relevant to the user and surface them
two ways:

1. **Email digest** (daily / twice-daily) of new, relevant missions.
2. **Browsable dashboard** backed by D1, with filters, search, and history.

France-first, but the source layer is a pluggable registry so global boards can
be added later without touching the pipeline.

**Non-goals (YAGNI, deferred):** contact enrichment (recruiter email/phone),
AI-drafted outreach, freelance marketplaces (Malt/Comet), multi-user, billing.
None block the core loop; all can be added later.

---

## 2. Cloudflare free-tier constraints (the design's true north)

Verified against current Cloudflare docs (2026-05-27). These limits dictate the
architecture, not the other way around.

| Resource | Free-tier limit | Consequence |
|---|---|---|
| Workers AI | 10,000 Neurons/day; Llama 3.1 8B ≈ ~200/call → **~50 AI calls/day** | Pre-filter must cut volume hard; AI only on a few dozen candidates/day |
| Worker CPU | **10 ms CPU per invocation** (I/O wait excluded) | No monolithic scan; bounded work per tick |
| Subrequests | **50 per invocation** (each fetch/D1/AI call counts) | Same — stage the pipeline |
| Cron triggers | 5/account; 15-min max wall-clock | A few staged crons, not one giant job |
| D1 | 500 MB DB; ~5M row-reads & 100k row-writes/day | Ample for missions |
| Email send | Not supported on free | Send digest via **Resend** (free ~3k/mo) over `fetch()` |
| Queues | Requires paid plan | **D1 is the work queue**; cron ticks drain it |

**Key implication:** the pipeline is **tick-based and staged**. Each cron firing
does one small, bounded slice of work, reading its to-do list from D1 and writing
results back. Many cheap ticks/day add up to full coverage while never nearing a
limit. This is the serverless form of what `runner.py` did in a single process.

---

## 3. Architecture

A **single Worker** with two entry points:

- **`scheduled(controller, env, ctx)`** — the cron pipeline. Branches on
  `controller.cron` to run one stage (fetch / score / digest).
- **`fetch(request, env, ctx)`** — serves the dashboard via the **Static Assets**
  binding plus a small JSON API (`/api/missions`, `/api/stats`, `/api/runs`),
  locked behind **Cloudflare Access** (free Zero Trust, scoped to the user's
  Google identity — no auth code to build/maintain).

### Staged ticks (each well under 10 ms CPU / 50 subrequests)

1. **`fetch` tick** — cron `*/30 * * * *` (every 30 min)
   Round-robins 2–3 source adapters per firing → cheap keyword pre-filter →
   insert survivors into `candidates` (`status='pending'`), deduped by
   `(source, external_id)`. Which adapters run is chosen from `source_state` so
   no single tick is heavy and all sources get serviced over time.

2. **`score` tick** — cron `*/15 * * * *` (every 15 min)
   Pull a small capped batch of `pending` candidates → Workers AI
   (`@cf/meta/llama-3.1-8b-instruct`) extracts structured fields + relevance
   score + reason → upsert into `missions`, set candidate `status='scored'`.
   Batch size capped to stay within the daily Neuron budget (see §5).

3. **`digest` tick** — cron `0 7,17 * * *` (07:00 & 17:00 UTC)
   Select missions scored since the last digest with `score >= threshold` and
   `notified=0` → render HTML → send via Resend → mark `notified=1`.

> Note: 3 distinct cron expressions ≤ the 5-trigger free cap. Stage selection is
> a `switch (controller.cron)`.

### Module layout (proposed)

```
src/
  index.ts            # Worker entry: scheduled() + fetch() routing
  pipeline/
    fetchTick.ts      # stage 1
    scoreTick.ts      # stage 2
    digestTick.ts     # stage 3
  sources/
    registry.ts       # adapter registry
    types.ts          # Source adapter interface, RawMission
    freework.ts       # Phase 1 adapters...
    reddit.ts
    wttj.ts
    telegram.ts
    linkedin.ts       # Phase 2, flagged off
  matching/
    prefilter.ts      # deterministic keyword/regex gate
    score.ts          # Workers AI extract + score
    prompt.ts         # system/user prompt + JSON schema
  store/
    db.ts             # D1 helpers (prepared statements only)
    migrations/       # SQL migrations
  notify/
    resend.ts         # email send
    digest.ts         # HTML rendering
  dashboard/          # static assets (served via ASSETS binding)
  config.ts           # user profile (editable, no pipeline code)
  http/
    api.ts            # JSON API handlers
wrangler.jsonc
```

---

## 4. Source adapters (pluggable registry)

Each adapter implements a common interface with built-in good-citizen behavior:

```ts
interface SourceAdapter {
  id: string;                       // e.g. "freework"
  enabled: boolean;                 // config/flag controlled
  // Conditional + rate-limited fetch; returns raw, un-scored items.
  fetch(ctx: AdapterCtx): Promise<RawMission[]>;
}

interface RawMission {
  source: string;
  externalId: string;               // stable per-source id for dedup
  url: string;
  title: string;
  body: string;
  postedAt?: string;                // ISO 8601 if known
  raw?: unknown;                     // source-specific payload
}

interface AdapterCtx {
  state: SourceState;               // cursor/ETag/last-run from D1
  fetchJson<T>(url: string, init?: RequestInit): Promise<T>; // wraps backoff + UA + conditional headers
}
```

Shared HTTP helper enforces: descriptive User-Agent, `ETag`/`If-Modified-Since`
conditional requests, exponential backoff on 429/403 honoring `Retry-After`,
per-source request cap, and low frequency.

**Phase 1 (sanctioned, free, no auth):**
- **Free-Work** — RSS/JSON listings where available.
- **Welcome to the Jungle** — RSS/JSON listings.
- **Hellowork** — RSS where available.
- **Reddit** — JSON API (`r/forhire`, FR freelance subs), no auth.
- **Telegram** — official Bot API on freelance channels.

**Phase 2 (isolated, flagged off):**
- **LinkedIn** — see §8. Not on the free critical path.

Adding a global board later = one new adapter file + a registry entry.

---

## 5. Matching funnel

### Stage A — deterministic pre-filter (free)
From `config.ts`: include keywords (skills), exclude keywords (kill `CDI`,
`stage`, `alternance`, `apprentissage`, pure self-promo markers), TJM regex
extraction + lowball flag, language guess. Cuts ~90% of volume before any AI.
Only survivors become `candidates`.

### Stage B — Workers AI extract + score
Model: `@cf/meta/llama-3.1-8b-instruct` (balanced; handles French; supports
structured output). JSON-constrained output:

```jsonc
{
  "is_real_mission": true,          // false ⇒ discard (CDI, promo, recycled, recruiter spam)
  "rate_eur_per_day": 600,          // null if absent
  "duration": "6 mois",             // free text or null
  "remote": "full" | "hybrid" | "onsite" | "unknown",
  "location": "Paris" ,             // null if absent
  "skills": ["react","typescript"],
  "client_type": "direct" | "esn" | "agency" | "unknown",
  "score": 0-100,                   // relevance to the configured profile
  "reason": "one-line why"
}
```

**Neuron budget:** ≤ ~40 scoring calls/day (buffer under the 50-call ceiling).
The `score` tick batch size = `floor(remaining_daily_budget / ticks_remaining)`,
tracked in `runs`. If budget exhausted, candidates stay `pending` for next day.
Model binding is swappable (e.g. `llama-3.2-3b` to stretch budget, or Claude API
later) without touching pipeline logic.

---

## 6. Data model (D1)

```sql
CREATE TABLE candidates (
  id           INTEGER PRIMARY KEY,
  source       TEXT NOT NULL,
  external_id  TEXT NOT NULL,
  url          TEXT NOT NULL,
  title        TEXT NOT NULL,
  body         TEXT NOT NULL,
  posted_at    TEXT,
  fetched_at   TEXT NOT NULL,        -- ISO 8601
  status       TEXT NOT NULL DEFAULT 'pending', -- pending|scored|discarded
  UNIQUE(source, external_id)
);

CREATE TABLE missions (
  id           INTEGER PRIMARY KEY,
  candidate_id INTEGER NOT NULL REFERENCES candidates(id),
  source       TEXT NOT NULL,
  url          TEXT NOT NULL,
  title        TEXT NOT NULL,
  rate_eur_day INTEGER,
  duration     TEXT,
  remote       TEXT,                 -- full|hybrid|onsite|unknown
  location     TEXT,
  skills       TEXT,                 -- JSON array
  client_type  TEXT,                 -- direct|esn|agency|unknown
  score        INTEGER NOT NULL,
  reason       TEXT,
  first_seen   TEXT NOT NULL,
  last_seen    TEXT NOT NULL,
  notified     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_missions_score ON missions(score);
CREATE INDEX idx_missions_notified ON missions(notified, score);

CREATE TABLE source_state (
  source       TEXT PRIMARY KEY,
  etag         TEXT,
  last_modified TEXT,
  cursor       TEXT,
  last_run_at  TEXT
);

CREATE TABLE runs (
  id           INTEGER PRIMARY KEY,
  tick         TEXT NOT NULL,        -- fetch|score|digest
  started_at   TEXT NOT NULL,
  finished_at  TEXT,
  stats        TEXT                  -- JSON: counts, neurons used, errors
);
```

All access via prepared statements with `bind()` (no string interpolation).
Booleans stored as 0/1; timestamps as ISO 8601 TEXT.

---

## 7. Notifications & dashboard

**Email digest (Resend):** grouped by score band; each entry shows title, rate,
remote, client type, the AI's one-line *why*, and a direct link. Threshold and
schedule are config. Resend API key in a Worker secret.

**Dashboard:** lightweight TypeScript + HTML (no heavy framework), served as
static assets from the same Worker. Sortable/filterable table, score chips,
source filter, full-text search, run history — mirrors the `scrapouille`
dashboard. JSON API (`/api/missions`, `/api/stats`, `/api/runs`) backs it.

**Auth:** Cloudflare Access (free Zero Trust) scoped to the user's identity —
zero auth code.

---

## 8. Platform Safety & Compliance (first-class)

- **Phase-1 sources are sanctioned data paths** (RSS / JSON / official Bot APIs).
  Ban risk is ~0 by construction — these are meant to be consumed.
- **Every adapter** enforces: rate-limit, exponential backoff on 429/403,
  `Retry-After` respect, `ETag`/`If-Modified-Since` conditional requests, honest
  descriptive User-Agent, robots.txt awareness, low frequency.
- **LinkedIn is isolated and OFF by default.** If ever enabled: throwaway account
  only, human-paced tiny volume, prefer licensed aggregators / official Jobs data
  so the ToS burden isn't on the user. Requires the Workers **Paid** plan (Browser
  Rendering) or an external authenticated runner pushing into D1 via the API.
- **Will NOT be built:** residential-proxy rotation, fingerprint spoofing,
  CAPTCHA-solving, or any detection-evasion. These violate ToS, *raise* ban risk,
  and are out of scope. The stance is footprint minimization, not evasion.
- **CF egress caveat:** Workers egress from datacenter IPs; if a source is hostile
  to those, that's a signal to use its official API, not to fight it.

---

## 9. Config (`config.ts`) — editable profile

Seeded defaults (user tunes without touching pipeline code):

```ts
export const profile = {
  skills: ["typescript","react","svelte","node","cloudflare"],
  seniority: "senior",
  tjmTarget: { min: 500, max: 700, lowballBelow: 450 },
  remote: "prefer-remote",          // remote-first; Paris on-site OK
  onsiteCities: ["Paris"],
  hardKill: ["CDI","stage","alternance","apprentissage"],
  killClientTypes: [],              // e.g. ["esn"] to drop middlemen
  minDurationMonths: 3,
  language: "fr",                   // expand to ["fr","en"] for global
  scoreThreshold: 60,               // digest cutoff
  digestCron: "0 7,17 * * *",
};
```

---

## 10. Phasing / milestones

- **M1 — Skeleton, no AI:** Wrangler project, D1 schema + migrations, adapter
  interface, config, **one** source (Reddit or Free-Work), pre-filter, dashboard
  reading from D1. Provable end-to-end with zero AI cost.
- **M2 — AI scoring:** `score` tick with Workers AI + the remaining Phase-1
  sources. Neuron-budget tracking in `runs`.
- **M3 — Delivery:** Resend email digest + Cloudflare Access lockdown.
- **M4 — (optional, later):** LinkedIn module on paid plan or external runner.

---

## 11. Open questions / risks

- **Source feed availability:** exact RSS/JSON endpoints for Free-Work / WTTJ /
  Hellowork need confirmation during M1 (some may be HTML-only → adapter does
  light parsing within the CPU budget, or the source is dropped).
- **10 ms CPU for parsing:** large HTML/XML parses must stay lean; prefer JSON/RSS
  over full-page HTML. Measure per-adapter CPU in M1.
- **French extraction quality** on Llama 3.1 8B: validate on real posts in M2;
  fall back to a larger model occasionally or Claude API if quality is poor.
- **Resend free-tier caps** (daily/monthly) vs digest frequency — fine for 2/day.
