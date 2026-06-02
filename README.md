# missions-free

A personal freelance-mission scanner that runs **entirely on Cloudflare's free
tier**. It pulls mission posts from configured sources, pre-filters them against
your profile, asks a Workers AI model to score the survivors, serves the result
as a tiny dashboard plus a JSON API, and emails you a daily digest of the best
matches.

The "free" in the name is the design constraint, not a feature: every layer
(compute, storage, AI inference, scheduling, email) is sized to fit inside
Cloudflare's free allocation so the whole pipeline keeps running indefinitely
without a paid plan.

## What's built

| Milestone | Scope |
|---|---|
| **M1** | Deterministic pre-filter, D1 store, dashboard + JSON API. |
| **M2a** | Workers AI scoring tick (Llama 3.1 8B + function-calling), `missions` table, `/api/missions`. |
| **M2b** | Free-Work source adapter (JSON-LD Hydra / bare-array API) + reusable RSS parser. |
| **M3** | Daily digest email (Resend, top missions ≥ score 70), `/api/digest/preview`, Cloudflare Access in front of the dashboard. |

Run `npm test` for the current suite; see [Deploy](#deploy) to ship it.

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

                    ┌─────────────────────────┐
   0 5 cron ───────▶│   runDigestTick(env)    │
                    │  • un-notified missions │──▶  Resend email
                    │    ≥ score 70 & is_real │      (then rows marked
                    │  • render → send → mark │       notified — at-least-once)
                    └─────────────────────────┘

   GET /api/stats           ──┐
   GET /api/candidates        │
   GET /api/missions          ├──▶  handleApi  ──▶  dashboard  (escapeHtml + safeUrl)
   GET /api/runs              │
   GET /api/digest/preview  ──┘     (renders the next digest, read-only)
   GET /                  ──▶  ASSETS  (public/)
```

Everything is one Worker (`src/index.ts`). `scheduled()` dispatches on
`controller.cron` (three triggers: fetch, score, digest); `fetch()` routes
`/api/*` to `handleApi` and otherwise falls through to static assets. The
deployed dashboard/API sit behind Cloudflare Access (owner-only); the crons run
server-side and are unaffected by it.

## Free-tier constraints (the design's true north)

These are the limits everything is sized against:

| Resource | Free allocation | Sizing |
|---|---|---|
| Workers AI | **10 000 Neurons/UTC day** | Llama 3.1 8B ≈ 200 Neurons/call → ~50 scorings/day |
| Worker CPU | 10 ms per invocation (I/O excluded) | Pipeline is I/O-dominated |
| Subrequests | 50 per invocation | Worst-case tick ≈ 26 (8 × (AI + retry + D1) + 2 fixed) |
| Cron triggers | 5/account, ≤ 15 min wall clock | Uses 3 (`*/30` fetch, `*/15` score, `0 5` digest) |
| D1 | 500 MB DB; ~5 M row reads, 100 k writes/day | Comfortable headroom |
| Queues / Browser Rendering | Paid plan only | Avoided as a design constraint |
| Email send | Not free on CF | Uses [Resend](https://resend.com) free tier |
| Cloudflare Access | Free ≤ 50 users | Gates the dashboard/API |

## Project structure

```
src/
  index.ts              # Worker entry — scheduled() + fetch()
  config.ts             # User profile, scoring profile, AI/budget/digest constants
  types/env.ts          # Env bindings (DB, ASSETS, AI) + secrets
  http/api.ts           # /api/* route handlers (stats, candidates, missions, runs, digest preview)
  matching/prefilter.ts # Deterministic pre-filter (skills, hard-kill, TJM)
  sources/              # Per-source adapters
    reddit.ts           # r/forhire [Hiring] posts (disabled — unauth .json now 403s)
    free-work.ts        # Free-Work freelance listings (bare-array / Hydra JSON-LD API)
    rss.ts              # RSS-2.0 / Atom parser (used by future adapters)
    http.ts             # createFetchClients → { fetchJson, fetchText }
    registry.ts         # adapters[] consumed by fetchTick
    types.ts            # SourceAdapter, AdapterCtx, RawMission
  store/                # D1 helpers (candidates, missions, runs, budget)
  scoring/              # schema (function-calling), prompt, ai client
  email/                # digest html/text rendering + Resend client
  pipeline/             # Cron orchestrators — fetchTick + scoreTick + digestTick

migrations/             # D1 migrations applied by vitest-pool-workers and wrangler
public/                 # Dashboard — index.html + app.js (no build step)
test/                   # Vitest tests, mirroring src/ layout
docs/HANDOFF.md         # Session-bridge doc — resume notes for the next session
```

## Local development

```bash
npm install          # postinstall regenerates worker-configuration.d.ts
npm test             # vitest-pool-workers; auto-applies migrations
npm run test:watch   # incremental test runner
npm run dev          # wrangler dev (local Miniflare; AI calls still hit remote Workers AI)
```

The test suite runs **entirely local**: D1 is a local Miniflare SQLite, and each
scoring test injects a `vi.fn()` `AiLike` fake — no real Workers AI calls. To
keep the pool fully local, `vitest.config.ts` sets `remoteBindings: false`;
without it the pool would try to open a remote session to the deployed Worker,
which is behind Cloudflare Access and would block pool startup.

## Deploy

First-time setup (one-time per account):

```bash
npx wrangler login
npx wrangler d1 create missions-free
# Copy the printed database_id into wrangler.jsonc → d1_databases[0].database_id
npm run migrate:remote        # applies all migrations to remote D1
npm run deploy
```

The daily digest needs three secrets (Resend free tier — the `onboarding@resend.dev`
test sender delivers only to the Resend account's own email):

```bash
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put DIGEST_TO         # recipient address
npx wrangler secret put DIGEST_FROM       # e.g. onboarding@resend.dev
```

After this, all three crons fire automatically:
- `*/30 * * * *` → `runFetchTick`
- `*/15 * * * *` → `runScoreTick` (Neuron-budget-gated)
- `0 5 * * *` → `runDigestTick`

Optionally put the dashboard/API behind **Cloudflare Access** (Zero Trust → the
Worker's route → Restricted) so only your email can reach it; the crons are
server-side and keep running.

### Manual smoke test (consumes real Neurons)

```bash
npx wrangler dev --remote     # routes AI calls to live Workers AI; not behind Access
curl "http://localhost:8787/__scheduled?cron=*/30+*+*+*+*"
curl "http://localhost:8787/__scheduled?cron=*/15+*+*+*+*"
curl "http://localhost:8787/api/missions" | jq
```

Each scored candidate burns ~200 Neurons of the 10 000/day allocation. To inspect
the **deployed** (Access-gated) instance, log in via the browser or use
`npx wrangler tail`, or query remote D1 directly with `wrangler d1 execute … --remote`.

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

`profile` controls the deterministic pre-filter (hard rejects). `scoringProfile`
is interpolated into the scoring system prompt and shapes how the model scores
what passed the pre-filter. `DIGEST_MIN_SCORE` (same file) is the cutoff for
what gets emailed.

To swap the model (e.g. to `@cf/meta/llama-3.3-70b-instruct-fp8-fast` for better
French extraction at higher Neuron cost), change `AI_MODEL` in the same file.

## Tech stack

- **Runtime:** Cloudflare Workers (`compatibility_date: 2026-05-27`)
- **Storage:** Cloudflare D1 (SQLite at the edge)
- **Static assets:** Workers Assets (`public/`)
- **AI:** Workers AI — `@cf/meta/llama-3.1-8b-instruct` with function-calling
- **Email:** Resend (digest delivery)
- **Cron:** Workers scheduled triggers (×3 — fetch, score, digest)
- **Auth:** Cloudflare Access (Zero Trust) in front of the dashboard/API
- **Language:** TypeScript (strict)
- **Tests:** Vitest + `@cloudflare/vitest-pool-workers`
- **Tooling:** Wrangler 4

No runtime dependencies beyond what Cloudflare's runtime provides. No bundler,
no transpilation step besides what Wrangler runs.

## Conventions

- **Commits:** single short conventional-commits subject line. No body.
- **Hooks:** run normally. `--no-verify` is not used.
- **TDD:** failing test → confirm fail → implement → confirm pass → commit.
- **Design docs:** per-milestone specs/plans live under `docs/superpowers/`
  (git-ignored, local-only scratch). Durable decisions belong in committed ADRs.

## License

Personal project — no license declared. If you'd like to reuse pieces, please
open an issue first.
