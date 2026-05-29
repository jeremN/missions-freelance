# missions-free M2a — AI Scoring — Design Spec

**Date:** 2026-05-28
**Status:** Approved (pending spec review)
**Predecessors:** M1 (shipped) — `docs/superpowers/specs/2026-05-27-missions-free-scanner-design.md` §§ M2 split into M2a (this spec) + M2b (sources expansion, later).
**Author:** Jérémie (with Claude)

The pipeline today (M1) collects raw candidates from Reddit's `r/forhire`,
runs them through a deterministic pre-filter, and stores survivors in D1.
This spec adds the **judgment layer**: a Workers AI scoring tick that turns
`candidates` (passed prefilter, no semantic understanding) into `missions`
(structured fields, relevance score, ready to surface).

This is the value proposition of the whole project — "filter the noise" the
way FreelanceMention sells — implemented on Cloudflare Workers AI's free
allocation.

---

## 1. Goal & scope

- For each `pending` candidate, call a hosted LLM with **function-calling +
  JSON schema** to extract structured mission fields (rate, duration, remote,
  client type, skills) and a 0–100 relevance score with a one-line reason.
- Store the result in a new `missions` table (one row per scored candidate).
- Track Neuron consumption against Workers AI's free 10,000/day allocation;
  on budget exhaustion defer the rest of the day's work cleanly.
- Make the dashboard show scored missions instead of (or in addition to) raw
  candidates.

**Explicitly out of scope (later milestones):**
- Email digest delivery — M3.
- Cloudflare Access / auth — M3.
- New source adapters (Free-Work, WTTJ, Hellowork, Telegram) — M2b.
- LinkedIn — M4.
- AI Gateway, re-scoring, model-quality A/B testing — future.

---

## 2. Cloudflare constraints (still the north star)

Verified 2026-05-27. Unchanged from M1 spec:

| Resource | Free-tier limit | Consequence for M2a |
|---|---|---|
| Workers AI | 10,000 Neurons/day; Llama 3.1 8B ≈ ~200/call → **~50 calls/day** | Pre-filter has already cut volume to ~5–30/day; budget covers M2a with margin. |
| Worker CPU | 10 ms CPU per invocation | Score tick processes a small batch per firing, not all candidates at once. |
| Subrequests | 50 per invocation | Each AI call = 1 subrequest. Batch cap = 8 AI calls + ~5 D1 ops ≪ 50. |
| Cron triggers | 5/account | M1 uses 1 (`fetch`); M2a adds 1 (`score`); 3 free for M3 digest etc. |
| D1 | 500 MB DB; ~5M row-reads & 100k row-writes/day | Ample. |

---

## 3. Architecture (slots into the existing pipeline)

A second cron joins the existing `fetch` cron in the same Worker:

```
Cron                       Worker entry              Stage produces
*/30 * * * *  (fetch)  →   scheduled() switch  →    pending candidates  (M1)
*/15 * * * *  (score)  →   scheduled() switch  →    scored missions     (M2a)
```

### The `score` tick — staged pipeline (each invocation bounded)

1. **Compute today's remaining Neuron budget** from `runs` rows whose UTC date
   matches today. The `runs.stats` JSON already carries an arbitrary blob; we
   start writing a `neurons` field into it from M2a onward.
2. **Compute this tick's batch size:**
   `batchSize = min(floor(remaining / NEURONS_PER_CALL_GUESS), MAX_BATCH)`
   where `NEURONS_PER_CALL_GUESS = 200` and `MAX_BATCH = 8`. If
   `remaining < NEURONS_PER_CALL_GUESS`, this tick is a no-op (record an empty
   run and exit) — defer to next UTC day.
3. **SELECT** the oldest `batchSize` candidates with `status='pending'`
   (oldest-first drains the backlog).
4. **For each:**
   - Build prompt via the pure `prompt.ts` (system message = profile + task
     description; user message = candidate title + body).
   - Call `env.AI.run(AI_MODEL, {messages, tools: [extractionTool]})`.
   - Read the tool-call arguments (Workers AI binds the model's output to the
     declared JSON schema; malformed shapes are rare but possible).
   - Validate with the same schema (defense in depth) → on validation failure
     retry once with a stricter system prompt → on second failure set the
     candidate's `status='score-failed'`, log the raw output, and move on.
   - On success: `upsertMission(...)` into `missions`, set candidate
     `status='scored'`.
   - Read Workers AI's response `usage.neurons` and add to a running tick total.
5. **`recordRun`** with `stats: { batchSize, scored, failed, deferred,
   neurons }` so the next tick's budget calc is honest.

### What does NOT change in M2a

- The `fetch` tick (M1) keeps running unchanged.
- The pluggable adapter registry, pre-filter, source-state handling — all
  unchanged.
- The platform-safety posture (UA, backoff, conditional requests, sanctioned
  sources) — unchanged.

---

## 4. Workers AI integration

- **Model:** `@cf/meta/llama-3.1-8b-instruct`, name held in `config.ts` as the
  `AI_MODEL` constant. Swappable to `llama-3.2-3b-instruct` (cheaper, weaker)
  or `llama-3.3-70b-instruct-fp8-fast` (better, scarcer) via one edit + redeploy.
- **Mode:** function calling (`tools` parameter on `env.AI.run`). Workers AI
  binds the response to the declared JSON-schema, eliminating most malformed-
  output failures at the source.
- **Per-call Neuron usage:** Workers AI's response includes a `usage.neurons`
  field; we tally these into the tick's run stats so budget tracking is
  measured, not guessed.

### Extraction schema (the function's parameters)

```jsonc
{
  "type": "object",
  "required": ["is_real_mission", "remote", "client_type", "score", "reason"],
  "properties": {
    "is_real_mission":  { "type": "boolean" },
    "rate_eur_per_day": { "type": ["integer", "null"], "minimum": 0 },
    "duration":         { "type": ["string", "null"] },
    "remote":           { "enum": ["full", "hybrid", "onsite", "unknown"] },
    "location":         { "type": ["string", "null"] },
    "skills":           { "type": "array", "items": { "type": "string" }, "default": [] },
    "client_type":      { "enum": ["direct", "esn", "agency", "unknown"] },
    "score":            { "type": "integer", "minimum": 0, "maximum": 100 },
    "reason":           { "type": "string", "maxLength": 240 }
  }
}
```

`is_real_mission: false` does not skip storage — we still write the mission
row (with a 0 score generally) so the dashboard surfaces *why* something was
rejected by the AI. That makes prompt iteration auditable.

### Prompt strategy

- **System prompt:** English instructions (Llama follows English system
  prompts more reliably) describing the task, the user's profile in structured
  form (skills, target TJM, kill list, location preferences), and the rubric
  for the relevance score. Includes 2–3 one-line examples (few-shot) of what
  a `score=80` vs `score=20` post looks like.
- **User content:** the candidate's title + body verbatim (likely French).
  The model handles mixed-language input fine.
- The stricter retry prompt appends one line: `"You MUST call the
  extract_mission tool. Return only the tool-call, no prose."`

---

## 5. Budget tracking

`remainingBudget(db): Promise<number>`:
- Sums `runs.stats.neurons` over rows whose `started_at` falls in today's UTC
  day (`>= today_00_00_utc`).
- Subtracts from `DAILY_NEURON_BUDGET = 10_000`.
- Returns `max(0, …)`.

This is intentionally simple: no DO/KV/atomic counter. The single-Worker
serialized cron means tick-vs-tick races aren't real; the only race is with a
manual invocation, which is rare and self-corrects the next tick.

---

## 6. Data model changes

### Migration `0002_missions.sql`

```sql
CREATE TABLE missions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id    INTEGER NOT NULL UNIQUE REFERENCES candidates(id),
  source          TEXT NOT NULL,
  url             TEXT NOT NULL,
  title           TEXT NOT NULL,
  is_real_mission INTEGER NOT NULL,
  rate_eur_day    INTEGER,
  duration        TEXT,
  remote          TEXT,            -- full|hybrid|onsite|unknown
  location        TEXT,
  skills          TEXT,            -- JSON array
  client_type     TEXT,            -- direct|esn|agency|unknown
  score           INTEGER NOT NULL,
  reason          TEXT,
  raw_response    TEXT,            -- the LLM tool-call args, for debugging
  first_seen      TEXT NOT NULL,
  last_seen       TEXT NOT NULL,
  notified        INTEGER NOT NULL DEFAULT 0  -- claimed by M3 digest
);
CREATE INDEX idx_missions_score ON missions(score);
CREATE INDEX idx_missions_notified ON missions(notified, score);
```

The `candidates.status` text values extend without a schema change:
`pending → (scored | score-failed)`.

---

## 7. New module layout

```
src/
  config.ts                       # + export const AI_MODEL = "@cf/meta/llama-3.1-8b-instruct";
                                  # + DAILY_NEURON_BUDGET, NEURONS_PER_CALL_GUESS, MAX_BATCH
  scoring/
    schema.ts                     # JSON schema + TS type for the extraction tool
    prompt.ts                     # pure: build {system, user} messages from profile+candidate
    ai.ts                         # scoreCandidate(env, candidate, profile): wraps env.AI.run,
                                  #   schema-validates, retries once, returns {extraction, neurons}
  pipeline/
    scoreTick.ts                  # orchestrator mirroring fetchTick.ts shape
  store/
    missions.ts                   # upsertMission, getMissions(filters), getMissionsBy(...)
    budget.ts                     # remainingBudget(db) — pure SQL aggregation over runs
migrations/
  0002_missions.sql               # new table + indexes
src/index.ts                      # extend scheduled() switch: case "*/15 * * * *"
src/http/api.ts                   # + GET /api/missions  (paginated, sortable by score)
public/app.js                     # render scored missions; keep /api/candidates as a fallback view
wrangler.jsonc                    # triggers.crons += "*/15 * * * *"
```

The existing `store/db.ts` is not modified — we add `store/missions.ts` and
`store/budget.ts` rather than growing the original file. Same for adding
`pipeline/scoreTick.ts` next to `fetchTick.ts`.

---

## 8. Error handling & resilience

| Failure | Behavior |
|---|---|
| AI call throws (network / quota / 5xx) | Retry once after backoff; on second failure log + mark candidate `score-failed`; continue tick |
| AI returns invalid JSON / schema mismatch | Retry once with stricter system prompt; on second failure log + mark `score-failed`; continue tick |
| D1 write of `missions` row fails | Wrap insert + status update in `db.batch` (atomic); on failure the candidate stays `pending` and the next tick retries |
| Budget exhausted | No-op tick; record an empty run with `deferred=batchSize_intended` for visibility |
| `runs` not yet populated for today | `remainingBudget` returns the full 10,000 |
| Reverse-clock drift | Budget calc uses `runs.started_at >= utcMidnight()`; trivial day-boundary correctness |

Crucially: a `score-failed` candidate is *not* retried automatically.
Re-scoring is an M3+ operation (manual D1 reset for now); avoids burning
Neurons on the same broken post forever.

---

## 9. Testing strategy

- **Unit (no AI binding, instant):**
  - `prompt.ts` — given fixture profile + fixture candidate, returns the
    expected `{system, user}` messages; few-shot examples present.
  - `schema.ts` — validates good/bad payload fixtures; round-trips a known
    response.
  - `budget.ts` — `remainingBudget` against a `runs` fixture (today + yesterday
    + edge-of-UTC-day rows).

- **Integration (real local D1, mocked AI):**
  - `scoreTick.ts` end-to-end via the workers test pool. The `env.AI` binding
    is mocked at the miniflare level via `vitest.config.ts`'s
    `miniflare.bindings`, returning canned tool-call responses + a `usage`
    field. Test cases:
    1. Happy path: batch of 3 pending → 3 scored, missions rows present,
       neurons recorded.
    2. One malformed response → retry → success.
    3. One persistently malformed → marked `score-failed`, no mission row,
       tick continues.
    4. Budget already exhausted (run rows with `neurons` summing > 9,800) →
       no-op tick, no AI calls made.
    5. Day-boundary: yesterday's neurons don't count against today's budget.

- **No real Workers AI calls in CI.** A single manual `wrangler dev --remote`
  verification before merge — pass through 1 real candidate and confirm
  output looks reasonable + the dashboard renders it.

---

## 10. Free-tier budget impact

**Per `score` tick (worst case, batch of 8):**
- 1 `getRecentRuns` for budget
- 1 `SELECT pending LIMIT 8`
- Per candidate (×8): 1 `env.AI.run` + 1 `INSERT missions` + 1 `UPDATE candidates`
- 1 final `recordRun`
- Total: **~26 subrequests/invocation** — well under 50.

**Per day (best case fully utilized):**
- 96 ticks/day × avg batch 0.5 ≈ 48 AI calls × 200 Neurons = **~9,600 Neurons/day**.
- 96 D1 budget reads + ~50 candidates × 3 D1 ops ≈ 250 D1 calls/day — far under
  the 100k writes / 5M reads/day caps.

---

## 11. Phasing inside M2a

1. **Foundation:** migration 0002 + `store/missions.ts` + `store/budget.ts` + tests.
   *Proves the schema and budget logic with zero AI cost.*
2. **Pure scoring layer:** `scoring/schema.ts` + `scoring/prompt.ts` + tests.
   *Pure logic, instant unit tests.*
3. **AI client:** `scoring/ai.ts` with mocked AI binding + tests covering
   happy-path, malformed-retry, exhaustion.
4. **Pipeline:** `pipeline/scoreTick.ts` + integration tests.
5. **Wiring:** cron in `wrangler.jsonc`, switch case in `index.ts`,
   `/api/missions` route, dashboard view + score chips, manual verify.

Each phase ends green-tests and committable.

---

## 12. Open questions / risks

- **French extraction quality:** validated only in M2a phase 5 manual check.
  If it disappoints, swap to 70B (5× Neuron cost — would force smaller batch),
  or eventually layer Claude API for high-value posts. Designed to be a one-
  string change.
- **`is_real_mission: false` flood:** if r/forhire is mostly noise, we'd burn
  Neurons on garbage. The deterministic pre-filter already drops most junk,
  but watch the early data and tighten `hardKill` if needed.
- **Workers AI cold start:** first call after idle can be 1-3 s. For a cron
  worker this is fine (no user is waiting).
- **`usage.neurons` field availability:** if a particular Workers AI model
  doesn't include this in the response (subject to change), fall back to
  `NEURONS_PER_CALL_GUESS` for accounting. The fallback is honest — slightly
  pessimistic — and avoids over-spend.
