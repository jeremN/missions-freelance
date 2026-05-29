# missions-free

A personal freelance-mission scanner that runs **entirely on Cloudflare's free
tier**. It scrapes mission posts from configured sources, pre-filters them
against your profile, asks a Workers AI model to score the survivors, and
serves the result as a tiny dashboard plus a JSON API.

The "free" in the name is the design constraint, not a feature: every layer
(compute, storage, AI inference, scheduling) is sized to fit inside Cloudflare's
free allocation so the whole pipeline keeps running indefinitely without a
paid plan.

## Status

| Milestone | Scope | State |
|---|---|---|
| **M1** | Reddit `r/forhire` adapter, deterministic pre-filter, D1 store, dashboard. | ✅ Shipped |
| **M2a** | Workers AI scoring tick (Llama 3.1 8B + function-calling), `missions` table, `/api/missions`. | ✅ Shipped |
| **M2b** | Free-Work source adapter (JSON-LD Hydra API). WTTJ dropped during recon — see spec §11.1. | ✅ Shipped |
| M3 | Daily digest email (Resend) and Cloudflare Access in front of the dashboard. | Planned |

Currently **86 tests** passing on `main`. The code has not yet been deployed
to Cloudflare — see [Deploy](#deploy) below.

## How it works

```
                    ┌─────────────────────────┐
   */30 cron ──────▶│   runFetchTick(env)     │
                    │  • per source adapter   │
                    │  • prefilter (skills,   │──▶  candidates  table
                    │    hard-kill, TJM)      │      (status='pending')
                    │  • insertCandidates     │
                    └─────────────────────────┘

                    ┌─────────────────────────┐
   */15 cron ──────▶│   runScoreTick(env)     │
                    │  • budget gate          │──▶  defers if   missions  table
                    │    (10 k Neurons/UTC d) │   <200 Neurons  (one per scored
                    │  • oldest-N pending     │     remain      candidate; status
                    │  • Workers AI w/ tool-  │                 flips to 'scored'
                    │    calling + retry      │                 or 'score-failed')
                    │  • atomic D1 batch      │
                    └─────────────────────────┘

   GET /api/stats       ──┐
   GET /api/candidates   │
   GET /api/missions     ├──▶  handleApi  ──▶  dashboard  (escapeHtml + safeUrl)
   GET /api/runs        ─┘
   GET /             ──▶  ASSETS  (public/)
```

Everything is one Worker (`src/index.ts`). `scheduled()` dispatches on
`controller.cron`; `fetch()` falls through to static assets when no API route
matches.

## Free-tier constraints (the design's true north)

Verified 2026-05-27 — these are the limits everything is sized against:

| Resource | Free allocation | M2a sizing |
|---|---|---|
| Workers AI | **10 000 Neurons/UTC day** | Llama 3.1 8B ≈ 200 Neurons/call → ~50 scorings/day |
| Worker CPU | 10 ms per invocation (I/O excluded) | Pipeline is I/O-dominated |
| Subrequests | 50 per invocation | Worst-case tick ≈ 26 (8 × (AI + retry + D1) + 2 fixed) |
| Cron triggers | 5/account, ≤ 15 min wall clock | Uses 2 (`*/30` fetch, `*/15` score) |
| D1 | 500 MB DB; ~5 M row reads, 100 k writes/day | Comfortable headroom |
| Queues / Browser Rendering | Paid plan only | Avoided as a design constraint |
| Email send | Not free on CF | M3 uses [Resend](https://resend.com) |

## Project structure

```
src/
  index.ts              # Worker entry — scheduled() + fetch()
  config.ts             # User profile, scoring profile, AI/budget constants
  types/env.ts          # Env bindings (DB, ASSETS, AI)
  http/api.ts           # /api/* route handlers (stats, candidates, missions, runs)
  matching/prefilter.ts # Deterministic pre-filter (skills, hard-kill, TJM)
  sources/              # Per-source adapters
    reddit.ts           # r/forhire [Hiring] posts (M1)
    free-work.ts        # Free-Work freelance listings (M2b, Hydra JSON-LD API)
    rss.ts              # RSS-2.0 / Atom parser (M2b, used by future adapters)
    http.ts             # createFetchClients → { fetchJson, fetchText }
    registry.ts         # adapters[] consumed by fetchTick
    types.ts            # SourceAdapter, AdapterCtx, RawMission
  store/                # D1 helpers (candidates, missions, runs, budget)
  scoring/              # M2a — schema (function-calling), prompt, ai client
  pipeline/             # Cron orchestrators — fetchTick (M1) + scoreTick (M2a)

migrations/             # D1 migrations applied by vitest-pool-workers and wrangler
public/                 # Dashboard — index.html + app.js (no build step)
test/                   # Vitest tests, mirroring src/ layout

docs/superpowers/specs/ # Design specs (per milestone)
docs/superpowers/plans/ # Implementation plans (per milestone)
docs/HANDOFF.md         # Session-bridge doc — last updated before M2a execution
```

## Local development

```bash
npm install          # postinstall regenerates worker-configuration.d.ts
npm test             # vitest-pool-workers; auto-applies migrations
npm run test:watch   # incremental test runner
npm run dev          # wrangler dev (local Miniflare; AI binding stubbed)
```

The test suite runs entirely against local D1 (Miniflare) with a fake AI
binding — **no real Workers AI calls in CI.** Each scoring test injects a
`vi.fn()` `AiLike` fake so the retry, budget, and atomic-upsert paths are
exercised deterministically.

## Deploy

First-time setup (one-time per account):

```bash
npx wrangler login
npx wrangler d1 create missions-free
# Copy the printed database_id into wrangler.jsonc → d1_databases[0].database_id
npm run migrate:remote        # applies 0001_init + 0002_missions to remote D1
npm run deploy
```

After this, both crons fire automatically:
- `*/30 * * * *` triggers `runFetchTick`
- `*/15 * * * *` triggers `runScoreTick` (Neuron-budget-gated)

### Manual smoke test (consumes real Neurons)

```bash
npx wrangler dev --remote     # routes AI calls to live Workers AI
curl "http://localhost:8787/__scheduled?cron=*/30+*+*+*+*"
curl "http://localhost:8787/__scheduled?cron=*/15+*+*+*+*"
curl "http://localhost:8787/api/missions" | jq
```

Each scored candidate burns ~200 Neurons of the 10 000/day allocation.

## Configuring your profile

Edit `src/config.ts` — two profile objects drive the whole pipeline:

```ts
export const profile: Profile = {
  skills: ["typescript", "react", "svelte", "node", "cloudflare", "javascript"],
  hardKill: ["cdi", "stage", "alternance", "apprentissage", "for hire"],
  tjm: { lowballBelow: 450 },
};

export const scoringProfile: ScoringProfile = {
  skills: profile.skills,           // shared with the pre-filter
  seniority: "senior",
  tjm: { min: 500, max: 700, lowballBelow: profile.tjm.lowballBelow },
  remotePreference: "remote-first",
  killClientTypes: [],              // e.g. ["esn"] to down-score ESNs
  minDurationMonths: 3,
};
```

`profile` controls the deterministic M1 pre-filter (hard rejects).
`scoringProfile` is interpolated into the M2a system prompt and shapes how
Llama scores what passed the pre-filter.

To swap the model (e.g. to `@cf/meta/llama-3.3-70b-instruct-fp8-fast` for
better French extraction at higher Neuron cost), change `AI_MODEL` in the
same file.

## Tech stack

- **Runtime:** Cloudflare Workers (`compatibility_date: 2026-05-27`)
- **Storage:** Cloudflare D1 (SQLite at the edge)
- **Static assets:** Workers Assets (`public/`)
- **AI:** Workers AI — `@cf/meta/llama-3.1-8b-instruct` with function-calling
- **Cron:** Workers scheduled triggers (×2)
- **Language:** TypeScript (strict)
- **Tests:** Vitest + `@cloudflare/vitest-pool-workers`
- **Tooling:** Wrangler 4

No runtime dependencies beyond what Cloudflare's runtime provides. No bundler,
no transpilation step besides what Wrangler runs.

## Conventions

- **Commits:** single short conventional-commits subject line. No body.
- **Hooks:** run normally. `--no-verify` is not used.
- **TDD:** failing test → confirm fail → implement → confirm pass → commit.
- **Reviews:** every implementation task gets a fresh spec-compliance review
  followed by a code-quality review; small reviewer fixes are folded into the
  task commit.
- **Specs and plans** live in `docs/superpowers/{specs,plans}/` — read those
  before extending a milestone.

## License

Personal project — no license declared. If you'd like to reuse pieces, please
open an issue first.
