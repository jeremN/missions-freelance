# missions-free M3 — Access Protection + Daily Digest Email — Design Spec

**Date:** 2026-06-01
**Status:** Approved (pending spec review)
**Predecessors:** M1 + M2a + M2b (all shipped + deployed) — see
`docs/superpowers/specs/2026-05-27-missions-free-scanner-design.md` (original
scanner spec), `2026-05-28-missions-free-m2a-ai-scoring-design.md` (AI scoring),
and `2026-05-29-missions-free-m2b-source-adapters-design.md` (source adapters).
**Author:** Jérémie (with Claude)

The pipeline is end-to-end live: three sources fetch into `candidates`, the
score tick turns them into scored `missions`, and a public dashboard renders
them. Two gaps remain before the tool is genuinely *useful* and *private*:

1. **The URL is wide open.** `handleApi` returns every scraped candidate and
   scored mission to anyone who knows `https://missions-free.jeremn-code.workers.dev`.
2. **It's pull-only.** Surfacing a good mission requires actively opening the
   dashboard. A freelancer wants to be *pushed* the day's top matches.

This spec closes both: **Part A** locks the URL to the owner via Cloudflare
Access (configuration, no code); **Part B** adds a once-daily **digest email**
of new high-scoring missions via Resend (code).

---

## 1. Goal & scope

**Primary goal:** Make the tool private and proactive. Only the owner can reach
the dashboard/API, and each morning the owner receives one email listing the
new missions worth looking at — with zero recurring cost.

**In scope:**

- **Part A (config):** Enable Cloudflare Access on the `workers.dev` route with
  an email-only allow policy. Documented as a runbook + a `curl` verification.
- **Part B (code):**
  - New `digest` cron `0 5 * * *` (≈07:00 Europe/Paris) → `runDigestTick`.
  - `src/email/resend.ts` — minimal Resend client behind an `EmailLike`
    interface (mirrors the `AiLike` seam in `src/scoring/ai.ts`).
  - `src/email/digest.ts` — pure `renderDigest(missions, opts)` →
    `{ subject, html, text }`. No I/O. HTML-escapes all scraped fields.
  - `src/pipeline/digestTick.ts` — select → render → send → mark-notified,
    with `recordRun` audit and injectable `email`/`now` for tests.
  - `getUnnotifiedMissions` + `markNotified` in `src/store/missions.ts`.
  - `GET /api/digest/preview` — render-only preview (no send, no mutation).
  - Wiring: `index.ts` cron case, `wrangler.jsonc` 3rd cron, `env.ts` secrets,
    `config.ts` constants.

**Explicitly out of scope (YAGNI / carried forward):**

- **Custom email domain / DKIM.** Uses Resend's shared `onboarding@resend.dev`
  sender, which may deliver only to the Resend-account email — exactly our
  single recipient. Swapping to a verified domain later is a `DIGEST_FROM`
  change, no code change.
- **In-Worker JWT verification** of `Cf-Access-Jwt-Assertion`. Access at the
  edge fully gates a `workers.dev` host; the in-Worker check only matters with
  a custom domain. Deferred.
- **Multi-recipient / unsubscribe / preferences.** Single owner recipient.
- **Per-mission "applied/dismissed" tracking.** M4+.
- **Retry/backoff on send failure** beyond "rolls to tomorrow" (see §6).
- **Re-notifying on re-score.** Once `notified=1`, a mission won't re-email
  even if a later re-score raises it. Acceptable; see §9.
- **Schema changes.** The `notified` column + `idx_missions_notified` already
  exist (migration `0002`). **No new migration.**
- **New runtime dependencies.** Resend is called over `fetch`; no SDK.

---

## 2. Cloudflare / vendor constraints (north star)

| Constraint | Value | M3 impact |
|---|---|---|
| Workers AI | 10 000 Neurons/UTC day | Untouched — digest reads DB only, no AI. |
| Cron triggers | 5/account, ≤15 min | Goes 2 → **3** of 5. Digest is a single SELECT + one HTTP POST + one UPDATE — milliseconds. |
| Subrequests | 50/invocation | Digest uses **1** (the Resend POST). |
| D1 | 500 MB; ~5M reads, 100k writes/day | Digest: one indexed SELECT + one batched UPDATE/day. Negligible. |
| Cloudflare Access | Free (Zero Trust ≤50 users) | Part A. Protects `*.workers.dev` directly — no custom domain. |
| Cloudflare Email Service | **Paid only** ($5/mo Workers Paid min) | **Rejected** — breaks the free-tier mandate. |
| Resend | Free: 3 000/mo, **100/day**, 1 domain | One digest/day ≈ 30/mo. Comfortably free. Test sender → own inbox needs no domain. |

---

## 3. Part A — Access protection (runbook, no code)

Cloudflare Access can gate a `workers.dev` subdomain natively (verified
2026-06-01, Cloudflare docs: *Workers → workers.dev → Enable Cloudflare
Access*). It sits at the edge in front of the `fetch` handler, so it covers the
dashboard **and** `/api/*` on the one shared hostname. The `scheduled` handler
(all three crons) never touches the HTTP edge, so fetch/score/**digest** ticks
run regardless of Access.

**Runbook (executed in the Cloudflare dashboard by the owner):**

1. **Workers & Pages → `missions-free` → Settings → Domains & Routes →
   `workers.dev` → Enable Cloudflare Access.**
2. In the auto-created Zero Trust Access application, add a policy:
   **Action = Allow**, **Include = Emails = `jeremie.nehlil.freelance@proton.me`**.
3. Login method: **one-time PIN** (default; no identity provider required).
4. **Verify** (un-authenticated request must be redirected to login):
   ```bash
   curl -sI https://missions-free.jeremn-code.workers.dev/        # expect 302 → *.cloudflareaccess.com
   curl -sI https://missions-free.jeremn-code.workers.dev/api/stats  # expect 302 (gated too)
   ```
5. **Confirm cron still runs:** after the next score/fetch tick, the dashboard
   (once logged in) shows new `runs` rows — proves the edge gate didn't break
   scheduled execution.

This runbook lives in the spec and in `docs/HANDOFF.md`. It is a manual,
one-time config step; it ships no repo changes.

---

## 4. Part B — components

Each unit has one purpose, a narrow interface, and is testable in isolation.

### 4.1 `src/email/resend.ts` — the send seam

```ts
export interface EmailMessage {
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface EmailLike {
  send(msg: EmailMessage): Promise<void>;
}

export function createResendClient(apiKey: string): EmailLike;
```

- `send` POSTs to `https://api.resend.com/emails` with
  `Authorization: Bearer <apiKey>` and a JSON body.
- **Throws on non-2xx** (includes status + truncated body). This is the
  contract `digestTick` relies on to decide whether to mark `notified`.
- No SDK; raw `fetch`. Mirrors how `AiLike` abstracts the AI binding so the
  pipeline can be unit-tested with a fake.

### 4.2 `src/email/digest.ts` — pure rendering

```ts
export interface DigestOpts { now: Date; minScore: number; }
export function renderDigest(
  missions: MissionRow[],
  opts: DigestOpts,
): { subject: string; html: string; text: string };
```

- **Pure** — no I/O, deterministic given inputs. Fully unit-testable.
- Subject: `missions-free — {n} new (top {maxScore})` (e.g.
  `missions-free — 5 new (top 92)`).
- Per mission (sorted score desc): score badge, **title linked to `url`**,
  rate (`{rate}€/j` or `—`), remote, source, duration, one-line `reason`.
- **Security — HTML escaping.** `title`, `reason`, `location`, `skills` come
  from scraped third-party postings (attacker-influenced). All interpolated
  text is HTML-escaped; `url` passes a `safeUrl` allowlist (`http`/`https`
  only) — same threat model and helpers as the dashboard's `escapeHtml` /
  `safeUrl` in `public/app.js`. A logic-light string template (no `eval`, no
  raw interpolation of untrusted values) keeps this injection-safe.
- Always emits a plain-text `text` alongside `html` (deliverability + clients
  that prefer text).

### 4.3 `src/store/missions.ts` — selection + marking

```ts
export function getUnnotifiedMissions(
  db: D1Database,
  opts: { minScore: number; limit: number },
): Promise<MissionRow[]>;

export function markNotified(db: D1Database, ids: number[]): Promise<void>;
```

- `getUnnotifiedMissions`:
  `WHERE notified = 0 AND is_real_mission = 1 AND score >= ?
   ORDER BY score DESC, last_seen DESC LIMIT ?` — served by
  `idx_missions_notified(notified, score)`.
- `markNotified`: batched `UPDATE missions SET notified = 1 WHERE id IN (...)`
  (parameterized, chunked if ever needed; `DIGEST_MAX_ITEMS` keeps it ≤20).
  No-op on empty input.

### 4.4 `src/pipeline/digestTick.ts` — orchestration

```ts
export interface DigestTickOptions { email?: EmailLike; now?: Date; }
export interface DigestTickResult {
  candidates: number; sent: boolean; skipped: boolean;
}
export function runDigestTick(env: Env, opts?: DigestTickOptions): Promise<DigestTickResult>;
```

See §5 for the algorithm. `email` defaults to
`createResendClient(env.RESEND_API_KEY)`; `now` defaults to `new Date()`. Both
injectable, mirroring `ScoreTickOptions`.

### 4.5 `GET /api/digest/preview` (stretch, in-scope)

In `src/http/api.ts`: render the *would-be* digest and return it as
`text/html` **without sending and without touching `notified`**. Lets the owner
eyeball formatting against live data (behind Access, read-only). This is a
deliberate, documented exception to the otherwise JSON-only `/api/*` contract
(§9). Empty selection still returns a valid "nothing new" page.

---

## 5. Data flow & algorithm

```
0 5 * * *  →  scheduled() → runDigestTick(env)
  1. rows = getUnnotifiedMissions(DB, { minScore: DIGEST_MIN_SCORE,
                                        limit: DIGEST_MAX_ITEMS })
  2. if rows.length === 0:
        recordRun("digest", { sent: false, skipped: true, candidates: 0 })
        return { candidates: 0, sent: false, skipped: true }
  3. { subject, html, text } = renderDigest(rows, { now, minScore })
  4. email.send({ from: DIGEST_FROM, to: DIGEST_TO, subject, html, text })  // throws on failure
  5. markNotified(DB, rows.map(r => r.id))        // only reached on send success
  6. recordRun("digest", { sent: true, candidates: rows.length }) in finally
```

### The one real architectural decision — at-least-once delivery

D1 cannot roll back across the external Resend HTTP call, so we **send first,
then mark `notified`**:

- **Crash between send and mark** → those missions re-send tomorrow (rare
  duplicate). Strictly preferable to the inverse (mark-then-send), where a send
  failure would *silently lose* a mission forever.
- The `notified` flag makes re-selection **idempotent** and immune to cron
  drift/DST: a mission is emailed exactly once under normal operation, at most
  twice across a crash.

Chosen: **at-least-once**, send-then-mark. Documented so the rare-duplicate
behavior is a known property, not a surprise.

---

## 6. Error handling

| Failure | Behavior |
|---|---|
| Send returns non-2xx / network error | `EmailLike.send` throws → `notified` **not** flipped → `recordRun` (in `finally`) logs `{ sent: false, error }` → missions roll to tomorrow's digest. |
| `getUnnotifiedMissions` throws | `recordRun` in `finally` still writes the audit row; tick returns/propagates without sending. |
| `markNotified` throws *after* a successful send | Audit shows `sent: true`; missions re-send tomorrow (at-least-once). Logged. |
| Missing `RESEND_API_KEY` | Client construction / send fails loudly; surfaced in logs + `runs`. (Secret is required for the digest cron to function.) |
| Empty selection | Not an error — `skipped: true`, no email (no empty digests). |

`recordRun` lives in a `finally` block exactly like `scoreTick`, so the audit
trail is complete on every path.

---

## 7. Configuration & secrets

**`src/config.ts`** (committed):
```ts
export const DIGEST_MIN_SCORE = 70;   // matches the dashboard's "good" band
export const DIGEST_MAX_ITEMS = 20;   // cap per email; overflow rolls to next day
```

**`src/types/env.ts`** — add to `Env`:
```ts
RESEND_API_KEY: string;   // secret
DIGEST_TO: string;        // secret — owner's inbox (keeps email out of the public repo)
DIGEST_FROM: string;      // secret — "onboarding@resend.dev" for now
```

Set via Wrangler (never committed):
```bash
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put DIGEST_TO      # jeremie.nehlil.freelance@proton.me
npx wrangler secret put DIGEST_FROM    # onboarding@resend.dev
```

`DIGEST_TO`/`DIGEST_FROM` are stored as secrets (not `vars`) specifically so
the owner's address never lands in the public GitHub repo. Tests inject a fake
`EmailLike` and pass `from`/`to` explicitly, so they need no real secrets.

**`wrangler.jsonc`** — extend `triggers.crons`:
```jsonc
"crons": ["*/30 * * * *", "*/15 * * * *", "0 5 * * *"]
```

**`src/index.ts`** — new case:
```ts
case "0 5 * * *":
  ctx.waitUntil(runDigestTick(env));
  break;
```

---

## 8. Testing (TDD — failing test first, per project convention)

- **`test/email/digest.test.ts`** — `renderDigest`: subject reflects count +
  top score; html & text contain titles/scores/links; empty input → valid
  "nothing new" output; **HTML-escaping**: a mission title containing
  `<script>`/`"`/`&` is escaped in `html`; a `javascript:` URL is dropped by
  `safeUrl`.
- **`test/email/resend.test.ts`** — `createResendClient(...).send`: POSTs to
  the right URL with `Authorization: Bearer`, correct JSON body; **throws on
  non-2xx**; resolves on 2xx. (Mock `fetch`.)
- **`test/pipeline/digestTick.test.ts`** — selects only `notified=0 ∧
  is_real_mission=1 ∧ score≥min`; **skips send + records run** when empty;
  calls `email.send` with rendered content on non-empty; marks **only the sent
  ids** `notified`; **does not** mark notified when `send` throws; records a run
  on both success and failure paths.
- **`test/store/missions.test.ts`** (extend) — `getUnnotifiedMissions` filter +
  order; `markNotified` flips exactly the given ids and is a no-op on `[]`.
- **`test/http/api.test.ts`** (extend) — `/api/digest/preview` returns rendered
  HTML and leaves `notified` unchanged (read-only).

All tests stay fully offline (fake `EmailLike`, mocked `fetch`, in-memory D1),
consistent with the existing 86-test suite.

---

## 9. Carry-forward / deferred

- **`notified` not reset on re-score.** A mission emailed once won't re-email if
  a later re-score raises its band. Add a `notified`-reset rule (or a
  `notified_score` watermark) if re-scoring becomes meaningful (M4+).
- **`/api/digest/preview` returns HTML**, breaking the JSON-only `/api/*`
  contract. Acceptable, single-purpose, documented; revisit if the API grows a
  formal content-negotiation story.
- **Single recipient** (`DIGEST_TO`). Multi-recipient/preferences are M4+.
- **No in-Worker `Cf-Access-Jwt-Assertion` check.** Add if/when a custom domain
  is introduced.
- **At-least-once duplicates** on crash between send and mark — known, accepted.
- **Per-adapter / per-source digest sectioning** (group by source) — not now.

---

## 10. Definition of done

1. `npm test` green, including the new digest/email/preview tests
   (86 → ~86+N passing).
2. `npx wrangler secret put` set for `RESEND_API_KEY`, `DIGEST_TO`,
   `DIGEST_FROM`; `wrangler.jsonc` has the 3rd cron; `npm run deploy` succeeds.
3. Part A runbook executed: un-authenticated `curl` to `/` and `/api/stats`
   returns 302 to Cloudflare Access; owner can log in via one-time PIN; a post-
   deploy score/fetch run still appears (cron unaffected).
4. `/api/digest/preview` (behind Access) renders a sane email against live data.
5. First real digest delivered to the owner's inbox at the next 07:00 Paris
   firing with at least one qualifying mission (or verified-empty otherwise).
6. `docs/HANDOFF.md` updated for post-M3 + the Access runbook.
