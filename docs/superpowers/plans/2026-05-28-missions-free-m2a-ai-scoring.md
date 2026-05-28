# missions-free — M2a (AI Scoring) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Workers-AI-driven scoring stage that turns M1's `candidates` (passed prefilter, no semantic understanding) into a new `missions` table with structured fields and a 0–100 relevance score, gated by a daily Neuron budget.

**Architecture:** A second cron (`*/15 * * * *`) on the existing Worker runs a `score` tick that reads remaining Neurons from `runs` history, picks an oldest-first batch of `pending` candidates, calls `env.AI.run` with **function-calling** bound to a JSON schema, retries-once-then-marks-failed on bad output, and upserts a `missions` row per success. All I/O is dependency-injected so the AI binding is replaced by a fake in tests — zero real AI calls in CI.

**Tech Stack:** TypeScript, Cloudflare Workers, **Workers AI** (`@cf/meta/llama-3.1-8b-instruct`), D1, Wrangler, Vitest + `@cloudflare/vitest-pool-workers`. No new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-05-28-missions-free-m2a-ai-scoring-design.md`.
**Predecessor:** M1 (shipped) — `docs/superpowers/plans/2026-05-27-missions-free-m1.md`.

---

## File Structure (M2a)

```
migrations/0002_missions.sql              # new missions table + indexes
src/scoring/
  schema.ts                               # JSON schema + TS type for extraction
  prompt.ts                               # pure: buildScoringPrompt(candidate, profile)
  ai.ts                                   # scoreCandidate(ai, candidate, profile) — calls env.AI.run with schema, retries once
src/pipeline/
  scoreTick.ts                            # runScoreTick(env, opts?) orchestrator
src/store/
  missions.ts                             # upsertMission, getMissions, type defs
  budget.ts                               # remainingBudget(db, now?) — pure SQL over runs
src/config.ts                             # MODIFY: AI_MODEL, DAILY_NEURON_BUDGET, NEURONS_PER_CALL_GUESS, MAX_BATCH
src/types/env.ts                          # MODIFY: + AI: Ai binding
src/http/api.ts                           # MODIFY: + GET /api/missions route
src/index.ts                              # MODIFY: scheduled() handles "*/15 * * * *"
wrangler.jsonc                            # MODIFY: ai binding + add "*/15 * * * *" trigger
public/index.html                         # MODIFY: missions section markup
public/app.js                             # MODIFY: render missions instead of (or above) candidates
test/store/missions.test.ts
test/store/budget.test.ts
test/scoring/schema.test.ts
test/scoring/prompt.test.ts
test/scoring/ai.test.ts
test/pipeline/scoreTick.test.ts
test/index.test.ts                        # MODIFY: extend e2e to cover /api/missions
```

**Execution order:** linear — Task 0 lays foundation; Tasks 1–6 each unblock the next; Task 7 wires everything for end-to-end verification.

**What M2a deliberately omits (per spec §1):** new source adapters (M2b), email digest (M3), Cloudflare Access (M3), LinkedIn (M4), re-scoring of already-scored candidates.

---

## Task 0: Foundation — migration, AI binding, config

**Files:**
- Create: `migrations/0002_missions.sql`
- Modify: `wrangler.jsonc`, `src/types/env.ts`, `src/config.ts`

- [ ] **Step 1: Create `migrations/0002_missions.sql`**

```sql
CREATE TABLE IF NOT EXISTS missions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id    INTEGER NOT NULL UNIQUE REFERENCES candidates(id),
  source          TEXT NOT NULL,
  url             TEXT NOT NULL,
  title           TEXT NOT NULL,
  is_real_mission INTEGER NOT NULL,
  rate_eur_day    INTEGER,
  duration        TEXT,
  remote          TEXT,
  location        TEXT,
  skills          TEXT,                 -- JSON array
  client_type     TEXT,
  score           INTEGER NOT NULL,
  reason          TEXT,
  raw_response    TEXT,                 -- the LLM tool-call args, for debugging
  first_seen      TEXT NOT NULL,
  last_seen       TEXT NOT NULL,
  notified        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_missions_score ON missions(score);
CREATE INDEX IF NOT EXISTS idx_missions_notified ON missions(notified, score);
```

- [ ] **Step 2: Add the AI binding and the score cron to `wrangler.jsonc`**

Edit `wrangler.jsonc`. Inside the existing top-level object, add (or extend) the `"ai"` binding and append the new cron expression:

```jsonc
{
  // ... existing fields unchanged ...
  "ai": { "binding": "AI" },
  "triggers": {
    "crons": ["*/30 * * * *", "*/15 * * * *"]
  }
}
```

The full file should keep its existing `name`, `main`, `compatibility_date`, `observability`, `d1_databases`, and `assets` blocks untouched.

- [ ] **Step 3: Extend `src/types/env.ts`**

```ts
export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  AI: Ai;
}
```

- [ ] **Step 4: Extend `src/config.ts` with the M2a constants**

The file currently exports `Profile` and `profile`. Append the M2a constants after the existing `profile` declaration:

```ts
import type { PrefilterProfile } from "./matching/prefilter";

/** The user's editable profile — single source of truth for the pre-filter. */
export type Profile = PrefilterProfile;

export const profile: Profile = {
  skills: ["typescript", "react", "svelte", "node", "cloudflare", "javascript"],
  hardKill: ["cdi", "stage", "alternance", "apprentissage", "for hire"],
  tjm: { lowballBelow: 450 },
};

// ----- M2a (AI scoring) -----------------------------------------------------

export const AI_MODEL = "@cf/meta/llama-3.1-8b-instruct";

/** Cloudflare Workers AI free allocation per UTC day. */
export const DAILY_NEURON_BUDGET = 10_000;

/** Conservative per-call estimate used to size each tick's batch. */
export const NEURONS_PER_CALL_GUESS = 200;

/** Hard cap on AI calls per score-tick invocation (keeps subrequests safely < 50). */
export const MAX_BATCH = 8;

/** A more focused profile slice passed to the LLM as task context. */
export interface ScoringProfile {
  skills: string[];
  seniority: string;
  tjm: { min: number; max: number; lowballBelow: number };
  remotePreference: "remote-first" | "onsite-ok-paris" | "any";
  killClientTypes: Array<"esn" | "agency">;
  minDurationMonths: number;
}

export const scoringProfile: ScoringProfile = {
  skills: profile.skills,
  seniority: "senior",
  tjm: { min: 500, max: 700, lowballBelow: profile.tjm.lowballBelow },
  remotePreference: "remote-first",
  killClientTypes: [],
  minDurationMonths: 3,
};
```

- [ ] **Step 5: Regenerate types and verify existing tests still pass**

Run:
```bash
npx wrangler types
npm test
```
Expected: `wrangler types` succeeds (now includes the `AI` binding in the generated `Env`); `npm test` still passes with all 39 prior tests green. No new tests yet — Task 0 is pure scaffolding.

If `wrangler types` complains that the AI binding requires a `compatibility_flags` like `nodejs_compat` to resolve types, add that flag to `wrangler.jsonc`. Otherwise leave compatibility flags untouched.

- [ ] **Step 6: Commit**

```bash
git add migrations/0002_missions.sql wrangler.jsonc src/types/env.ts src/config.ts
git commit -m "chore: add missions migration, AI binding, scoring config"
```

---

## Task 1: missions store helpers

**Files:**
- Create: `src/store/missions.ts`
- Test: `test/store/missions.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/store/missions.test.ts`:

```ts
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { insertCandidates } from "../../src/store/db";
import {
  getMissions,
  getMissionsForCandidate,
  upsertMission,
} from "../../src/store/missions";

beforeEach(async () => {
  await env.DB.exec("DELETE FROM missions");
  await env.DB.exec("DELETE FROM candidates");
});

async function seedCandidate(externalId = "c1"): Promise<number> {
  await insertCandidates(env.DB, [
    {
      source: "reddit",
      externalId,
      url: `https://x/${externalId}`,
      title: "Senior React mission",
      body: "6 mois, full remote, 600€/j.",
      tjm: 600,
      lowball: false,
    },
  ]);
  const row = await env.DB.prepare(
    "SELECT id FROM candidates WHERE external_id = ?",
  )
    .bind(externalId)
    .first<{ id: number }>();
  return row!.id;
}

describe("store/missions", () => {
  it("inserts a mission row for a candidate", async () => {
    const candidateId = await seedCandidate("c1");
    await upsertMission(env.DB, {
      candidateId,
      source: "reddit",
      url: "https://x/c1",
      title: "Senior React mission",
      isRealMission: true,
      rateEurDay: 600,
      duration: "6 mois",
      remote: "full",
      location: null,
      skills: ["react", "typescript"],
      clientType: "direct",
      score: 82,
      reason: "Stack match, day-rate in range, remote.",
      rawResponse: '{"score":82}',
    });
    const rows = await getMissions(env.DB, { limit: 10 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      candidateId,
      score: 82,
      isRealMission: true,
      remote: "full",
      clientType: "direct",
    });
    expect(rows[0].skills).toEqual(["react", "typescript"]);
    expect(rows[0].firstSeen).toBeTruthy();
    expect(rows[0].lastSeen).toBeTruthy();
  });

  it("upsert is idempotent — second call updates score/lastSeen but preserves firstSeen", async () => {
    const candidateId = await seedCandidate("c1");
    await upsertMission(env.DB, {
      candidateId,
      source: "reddit",
      url: "https://x/c1",
      title: "T",
      isRealMission: true,
      rateEurDay: null,
      duration: null,
      remote: "unknown",
      location: null,
      skills: [],
      clientType: "unknown",
      score: 40,
      reason: "first",
      rawResponse: "{}",
    });
    const first = (await getMissions(env.DB, { limit: 1 }))[0];
    await new Promise((r) => setTimeout(r, 10)); // ensure lastSeen advances

    await upsertMission(env.DB, {
      candidateId,
      source: "reddit",
      url: "https://x/c1",
      title: "T",
      isRealMission: true,
      rateEurDay: null,
      duration: null,
      remote: "unknown",
      location: null,
      skills: [],
      clientType: "unknown",
      score: 88,
      reason: "second",
      rawResponse: "{}",
    });
    const second = (await getMissions(env.DB, { limit: 1 }))[0];
    expect(second.score).toBe(88);
    expect(second.reason).toBe("second");
    expect(second.firstSeen).toBe(first.firstSeen); // preserved
    expect(second.lastSeen >= first.lastSeen).toBe(true); // advanced
  });

  it("getMissions returns highest-score first", async () => {
    const a = await seedCandidate("a");
    const b = await seedCandidate("b");
    const c = await seedCandidate("c");
    for (const [cid, score] of [
      [a, 30],
      [b, 90],
      [c, 60],
    ] as const) {
      await upsertMission(env.DB, {
        candidateId: cid,
        source: "reddit",
        url: "https://x",
        title: "T",
        isRealMission: true,
        rateEurDay: null,
        duration: null,
        remote: "unknown",
        location: null,
        skills: [],
        clientType: "unknown",
        score,
        reason: "",
        rawResponse: "{}",
      });
    }
    const rows = await getMissions(env.DB, { limit: 10 });
    expect(rows.map((r) => r.score)).toEqual([90, 60, 30]);
  });

  it("getMissionsForCandidate returns the mission tied to that candidate", async () => {
    const candidateId = await seedCandidate("c1");
    await upsertMission(env.DB, {
      candidateId,
      source: "reddit",
      url: "https://x",
      title: "T",
      isRealMission: false,
      rateEurDay: null,
      duration: null,
      remote: "unknown",
      location: null,
      skills: [],
      clientType: "unknown",
      score: 10,
      reason: "",
      rawResponse: "{}",
    });
    const m = await getMissionsForCandidate(env.DB, candidateId);
    expect(m?.score).toBe(10);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/store/missions.test.ts`
Expected: FAIL — `Cannot find module '../../src/store/missions'`.

- [ ] **Step 3: Write `src/store/missions.ts`**

```ts
export type Remote = "full" | "hybrid" | "onsite" | "unknown";
export type ClientType = "direct" | "esn" | "agency" | "unknown";

export interface MissionInput {
  candidateId: number;
  source: string;
  url: string;
  title: string;
  isRealMission: boolean;
  rateEurDay: number | null;
  duration: string | null;
  remote: Remote;
  location: string | null;
  skills: string[];
  clientType: ClientType;
  score: number;
  reason: string;
  rawResponse: string;
}

export interface MissionRow extends MissionInput {
  id: number;
  firstSeen: string;
  lastSeen: string;
  notified: boolean;
}

interface MissionDbRow {
  id: number;
  candidateId: number;
  source: string;
  url: string;
  title: string;
  isRealMission: number;
  rateEurDay: number | null;
  duration: string | null;
  remote: string;
  location: string | null;
  skills: string | null;
  clientType: string;
  score: number;
  reason: string | null;
  rawResponse: string | null;
  firstSeen: string;
  lastSeen: string;
  notified: number;
}

function hydrate(r: MissionDbRow): MissionRow {
  return {
    id: r.id,
    candidateId: r.candidateId,
    source: r.source,
    url: r.url,
    title: r.title,
    isRealMission: Boolean(r.isRealMission),
    rateEurDay: r.rateEurDay,
    duration: r.duration,
    remote: r.remote as Remote,
    location: r.location,
    skills: r.skills ? (JSON.parse(r.skills) as string[]) : [],
    clientType: r.clientType as ClientType,
    score: r.score,
    reason: r.reason ?? "",
    rawResponse: r.rawResponse ?? "",
    firstSeen: r.firstSeen,
    lastSeen: r.lastSeen,
    notified: Boolean(r.notified),
  };
}

const SELECT_COLS = `
  id, candidate_id AS candidateId, source, url, title,
  is_real_mission AS isRealMission, rate_eur_day AS rateEurDay,
  duration, remote, location, skills, client_type AS clientType,
  score, reason, raw_response AS rawResponse,
  first_seen AS firstSeen, last_seen AS lastSeen, notified`;

/**
 * Insert a mission for a candidate, or update score / lastSeen / extracted
 * fields if a mission for that candidate already exists. firstSeen is preserved
 * across re-scorings (re-scoring is not part of M2a but the column is honest).
 */
export async function upsertMission(
  db: D1Database,
  m: MissionInput,
): Promise<void> {
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO missions (
         candidate_id, source, url, title, is_real_mission, rate_eur_day,
         duration, remote, location, skills, client_type, score, reason,
         raw_response, first_seen, last_seen
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(candidate_id) DO UPDATE SET
         is_real_mission = excluded.is_real_mission,
         rate_eur_day    = excluded.rate_eur_day,
         duration        = excluded.duration,
         remote          = excluded.remote,
         location        = excluded.location,
         skills          = excluded.skills,
         client_type     = excluded.client_type,
         score           = excluded.score,
         reason          = excluded.reason,
         raw_response    = excluded.raw_response,
         last_seen       = excluded.last_seen`,
    )
    .bind(
      m.candidateId,
      m.source,
      m.url,
      m.title,
      m.isRealMission ? 1 : 0,
      m.rateEurDay,
      m.duration,
      m.remote,
      m.location,
      JSON.stringify(m.skills),
      m.clientType,
      m.score,
      m.reason,
      m.rawResponse,
      now,
      now,
    )
    .run();
}

export async function getMissions(
  db: D1Database,
  opts: { limit?: number; minScore?: number } = {},
): Promise<MissionRow[]> {
  const limit = Math.min(opts.limit ?? 100, 500);
  const minScore = opts.minScore ?? 0;
  const { results } = await db
    .prepare(
      `SELECT ${SELECT_COLS} FROM missions
        WHERE score >= ?
        ORDER BY score DESC, last_seen DESC
        LIMIT ?`,
    )
    .bind(minScore, limit)
    .all<MissionDbRow>();
  return results.map(hydrate);
}

export async function getMissionsForCandidate(
  db: D1Database,
  candidateId: number,
): Promise<MissionRow | null> {
  const row = await db
    .prepare(`SELECT ${SELECT_COLS} FROM missions WHERE candidate_id = ?`)
    .bind(candidateId)
    .first<MissionDbRow>();
  return row ? hydrate(row) : null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/store/missions.test.ts`
Expected: PASS (4 tests). If the migration doesn't auto-apply, confirm `vitest.config.ts` still reads `./migrations` (it does — that's the M1 setup unchanged).

- [ ] **Step 5: Commit**

```bash
git add src/store/missions.ts test/store/missions.test.ts
git commit -m "feat: add D1 store helpers for missions"
```

---

## Task 2: budget tracker

**Files:**
- Create: `src/store/budget.ts`
- Test: `test/store/budget.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/store/budget.test.ts`:

```ts
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { recordRun } from "../../src/store/db";
import { remainingBudget } from "../../src/store/budget";
import { DAILY_NEURON_BUDGET } from "../../src/config";

beforeEach(async () => {
  await env.DB.exec("DELETE FROM runs");
});

const NOW = new Date("2026-05-28T12:00:00.000Z");

async function seedRun(startedAt: string, neurons: number) {
  await recordRun(env.DB, {
    tick: "score",
    startedAt,
    finishedAt: startedAt,
    stats: { neurons },
  });
}

describe("remainingBudget", () => {
  it("returns the full budget when no runs exist today", async () => {
    expect(await remainingBudget(env.DB, NOW)).toBe(DAILY_NEURON_BUDGET);
  });

  it("subtracts today's recorded neurons from the daily budget", async () => {
    await seedRun("2026-05-28T03:00:00.000Z", 1500);
    await seedRun("2026-05-28T08:00:00.000Z", 800);
    expect(await remainingBudget(env.DB, NOW)).toBe(
      DAILY_NEURON_BUDGET - 2300,
    );
  });

  it("ignores runs from previous UTC days", async () => {
    await seedRun("2026-05-27T23:00:00.000Z", 5000); // yesterday
    expect(await remainingBudget(env.DB, NOW)).toBe(DAILY_NEURON_BUDGET);
  });

  it("returns 0 when today's neurons exceed the budget", async () => {
    await seedRun("2026-05-28T01:00:00.000Z", DAILY_NEURON_BUDGET + 1000);
    expect(await remainingBudget(env.DB, NOW)).toBe(0);
  });

  it("ignores runs whose stats JSON lacks a neurons field", async () => {
    await recordRun(env.DB, {
      tick: "fetch",
      startedAt: "2026-05-28T04:00:00.000Z",
      finishedAt: "2026-05-28T04:00:00.000Z",
      stats: { fetched: 10, inserted: 3 },
    });
    expect(await remainingBudget(env.DB, NOW)).toBe(DAILY_NEURON_BUDGET);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/store/budget.test.ts`
Expected: FAIL — `Cannot find module '../../src/store/budget'`.

- [ ] **Step 3: Write `src/store/budget.ts`**

```ts
import { DAILY_NEURON_BUDGET } from "../config";

/** Beginning of the UTC day containing `now`. */
function utcMidnight(now: Date): string {
  const d = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  return d.toISOString();
}

/**
 * How many Workers AI Neurons remain in today's free allocation.
 * Sums `stats.neurons` from `runs` rows started on/after today's UTC
 * midnight, treating missing/non-numeric fields as 0.
 */
export async function remainingBudget(
  db: D1Database,
  now: Date = new Date(),
): Promise<number> {
  const since = utcMidnight(now);
  const { results } = await db
    .prepare(
      `SELECT stats FROM runs
        WHERE started_at >= ?`,
    )
    .bind(since)
    .all<{ stats: string | null }>();

  let spent = 0;
  for (const r of results) {
    if (!r.stats) continue;
    try {
      const parsed = JSON.parse(r.stats) as { neurons?: unknown };
      const n = parsed.neurons;
      if (typeof n === "number" && Number.isFinite(n) && n > 0) spent += n;
    } catch {
      // Malformed JSON in stats should not crash the budget calc.
    }
  }
  return Math.max(0, DAILY_NEURON_BUDGET - spent);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/store/budget.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/store/budget.ts test/store/budget.test.ts
git commit -m "feat: add daily neuron budget tracker"
```

---

## Task 3: extraction schema

**Files:**
- Create: `src/scoring/schema.ts`
- Test: `test/scoring/schema.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/scoring/schema.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  EXTRACTION_TOOL,
  parseExtraction,
  type Extraction,
} from "../../src/scoring/schema";

describe("EXTRACTION_TOOL", () => {
  it("declares a function tool named extract_mission with required fields", () => {
    expect(EXTRACTION_TOOL.type).toBe("function");
    expect(EXTRACTION_TOOL.function.name).toBe("extract_mission");
    const req = EXTRACTION_TOOL.function.parameters.required;
    for (const k of ["is_real_mission", "remote", "client_type", "score", "reason"]) {
      expect(req).toContain(k);
    }
  });
});

describe("parseExtraction", () => {
  it("accepts a fully-populated valid payload", () => {
    const payload: Extraction = {
      is_real_mission: true,
      rate_eur_per_day: 600,
      duration: "6 mois",
      remote: "full",
      location: "Paris",
      skills: ["react", "typescript"],
      client_type: "direct",
      score: 82,
      reason: "Stack match, full-remote, rate in range.",
    };
    expect(parseExtraction(payload)).toEqual(payload);
  });

  it("fills sensible defaults for nullable / optional fields", () => {
    const payload = {
      is_real_mission: false,
      remote: "unknown",
      client_type: "unknown",
      score: 0,
      reason: "Not a freelance mission.",
    };
    const out = parseExtraction(payload);
    expect(out.rate_eur_per_day).toBeNull();
    expect(out.duration).toBeNull();
    expect(out.location).toBeNull();
    expect(out.skills).toEqual([]);
  });

  it("throws on missing required field", () => {
    expect(() =>
      parseExtraction({ is_real_mission: true, remote: "full", score: 50 }),
    ).toThrow(/required/i);
  });

  it("throws on out-of-range score", () => {
    expect(() =>
      parseExtraction({
        is_real_mission: true,
        remote: "full",
        client_type: "direct",
        score: 150,
        reason: "ok",
      }),
    ).toThrow(/score/);
  });

  it("throws on invalid enum value", () => {
    expect(() =>
      parseExtraction({
        is_real_mission: true,
        remote: "remote",
        client_type: "direct",
        score: 50,
        reason: "ok",
      }),
    ).toThrow(/remote/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/scoring/schema.test.ts`
Expected: FAIL — `Cannot find module '../../src/scoring/schema'`.

- [ ] **Step 3: Write `src/scoring/schema.ts`**

```ts
import type { Remote, ClientType } from "../store/missions";

export interface Extraction {
  is_real_mission: boolean;
  rate_eur_per_day: number | null;
  duration: string | null;
  remote: Remote;
  location: string | null;
  skills: string[];
  client_type: ClientType;
  score: number;
  reason: string;
}

const REMOTE_VALUES = ["full", "hybrid", "onsite", "unknown"] as const;
const CLIENT_VALUES = ["direct", "esn", "agency", "unknown"] as const;

/**
 * The JSON schema we declare to Workers AI's function-calling. The model
 * binds its output to this shape, so most malformed responses are blocked
 * at the source. We still validate in code (`parseExtraction`) for defense
 * in depth and to give callers a typed result.
 */
export const EXTRACTION_TOOL = {
  type: "function" as const,
  function: {
    name: "extract_mission",
    description:
      "Extract structured fields from a freelance mission posting and score its relevance for the configured profile.",
    parameters: {
      type: "object",
      required: ["is_real_mission", "remote", "client_type", "score", "reason"],
      properties: {
        is_real_mission: {
          type: "boolean",
          description:
            "True only if the post is offering a freelance/contract mission (not a CDI/permanent role, not self-promo, not a recycled call for candidates).",
        },
        rate_eur_per_day: {
          type: ["integer", "null"],
          minimum: 0,
          description: "Daily rate in EUR if stated, else null.",
        },
        duration: {
          type: ["string", "null"],
          description:
            "Free-form duration string, e.g. '6 mois', '3-6 months', 'long term'. Null if unstated.",
        },
        remote: {
          enum: REMOTE_VALUES,
          description:
            "'full' = fully remote; 'hybrid' = partial on-site; 'onsite' = on-site required; 'unknown' if unstated.",
        },
        location: {
          type: ["string", "null"],
          description:
            "City or region if stated (e.g. 'Paris', 'Île-de-France'), else null.",
        },
        skills: {
          type: "array",
          items: { type: "string" },
          default: [],
          description: "Technical skills mentioned in the post.",
        },
        client_type: {
          enum: CLIENT_VALUES,
          description:
            "'direct' = end client; 'esn' = ESN / service company middleman; 'agency' = recruiting agency; 'unknown' if unclear.",
        },
        score: {
          type: "integer",
          minimum: 0,
          maximum: 100,
          description: "0–100 relevance score for the configured profile.",
        },
        reason: {
          type: "string",
          maxLength: 240,
          description: "One-line justification for the score.",
        },
      },
    },
  },
} as const;

/** Type guard / runtime validator for extraction payloads. Throws on bad input. */
export function parseExtraction(input: unknown): Extraction {
  if (typeof input !== "object" || input === null) {
    throw new Error("extraction: expected object");
  }
  const v = input as Record<string, unknown>;

  const requireDefined = (k: string) => {
    if (v[k] === undefined) throw new Error(`extraction: required field "${k}" missing`);
  };
  for (const k of ["is_real_mission", "remote", "client_type", "score", "reason"]) {
    requireDefined(k);
  }

  if (typeof v.is_real_mission !== "boolean") {
    throw new Error("extraction: is_real_mission must be boolean");
  }
  if (typeof v.score !== "number" || !Number.isInteger(v.score) || v.score < 0 || v.score > 100) {
    throw new Error("extraction: score must be integer 0..100");
  }
  if (typeof v.reason !== "string") {
    throw new Error("extraction: reason must be string");
  }
  if (!REMOTE_VALUES.includes(v.remote as Remote)) {
    throw new Error(`extraction: remote must be one of ${REMOTE_VALUES.join("|")}`);
  }
  if (!CLIENT_VALUES.includes(v.client_type as ClientType)) {
    throw new Error(`extraction: client_type must be one of ${CLIENT_VALUES.join("|")}`);
  }

  const rate =
    v.rate_eur_per_day === undefined || v.rate_eur_per_day === null
      ? null
      : Number(v.rate_eur_per_day);
  if (rate !== null && (!Number.isFinite(rate) || rate < 0)) {
    throw new Error("extraction: rate_eur_per_day must be a non-negative number or null");
  }

  return {
    is_real_mission: v.is_real_mission,
    rate_eur_per_day: rate,
    duration:
      v.duration === undefined || v.duration === null ? null : String(v.duration),
    remote: v.remote as Remote,
    location:
      v.location === undefined || v.location === null ? null : String(v.location),
    skills: Array.isArray(v.skills)
      ? v.skills.filter((s): s is string => typeof s === "string")
      : [],
    client_type: v.client_type as ClientType,
    score: v.score,
    reason: v.reason,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/scoring/schema.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/scoring/schema.ts test/scoring/schema.test.ts
git commit -m "feat: add extraction tool schema and parseExtraction validator"
```

---

## Task 4: scoring prompt

**Files:**
- Create: `src/scoring/prompt.ts`
- Test: `test/scoring/prompt.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/scoring/prompt.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildScoringPrompt, STRICT_RETRY_NOTE } from "../../src/scoring/prompt";
import type { ScoringProfile } from "../../src/config";

const profile: ScoringProfile = {
  skills: ["react", "typescript", "node"],
  seniority: "senior",
  tjm: { min: 500, max: 700, lowballBelow: 450 },
  remotePreference: "remote-first",
  killClientTypes: [],
  minDurationMonths: 3,
};

const candidate = {
  source: "reddit",
  externalId: "p1",
  url: "https://x/p1",
  title: "[Hiring] Senior React/TS freelancer, full remote",
  body: "6 months, 600€/j, direct client (no ESN). Start ASAP.",
};

describe("buildScoringPrompt", () => {
  it("returns one system + one user message", () => {
    const { messages } = buildScoringPrompt(candidate, profile);
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("system");
    expect(messages[1].role).toBe("user");
  });

  it("includes the user profile in the system prompt", () => {
    const { messages } = buildScoringPrompt(candidate, profile);
    const sys = messages[0].content;
    expect(sys).toContain("react");
    expect(sys).toContain("typescript");
    expect(sys).toContain("500");
    expect(sys).toContain("700");
    expect(sys).toContain("senior");
  });

  it("puts the candidate text verbatim in the user message", () => {
    const { messages } = buildScoringPrompt(candidate, profile);
    expect(messages[1].content).toContain(candidate.title);
    expect(messages[1].content).toContain(candidate.body);
  });

  it("includes at least two few-shot anchors in the system prompt", () => {
    const { messages } = buildScoringPrompt(candidate, profile);
    const sys = messages[0].content;
    // Anchors document what "score 80" and "score 20" look like.
    expect(sys).toMatch(/score\s*[:=]?\s*80/i);
    expect(sys).toMatch(/score\s*[:=]?\s*20/i);
  });

  it("the strict retry variant appends a forcing note to the system message", () => {
    const { messages } = buildScoringPrompt(candidate, profile, { strict: true });
    expect(messages[0].content).toContain(STRICT_RETRY_NOTE);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/scoring/prompt.test.ts`
Expected: FAIL — `Cannot find module '../../src/scoring/prompt'`.

- [ ] **Step 3: Write `src/scoring/prompt.ts`**

```ts
import type { ScoringProfile } from "../config";

export interface PromptCandidate {
  source: string;
  externalId: string;
  url: string;
  title: string;
  body: string;
}

export interface ChatMessage {
  role: "system" | "user";
  content: string;
}

export interface BuiltPrompt {
  messages: ChatMessage[];
}

export const STRICT_RETRY_NOTE =
  "You MUST call the extract_mission tool. Return ONLY a tool-call, no prose.";

function buildSystemPrompt(profile: ScoringProfile, strict: boolean): string {
  const skills = profile.skills.join(", ");
  const killClients = profile.killClientTypes.length
    ? profile.killClientTypes.join(", ")
    : "none";

  const base = `
You score freelance mission posts for a specific user and extract structured
fields. Always respond by calling the extract_mission tool — never reply with
prose. Input posts may be in French or English; handle both.

USER PROFILE
- Skills: ${skills}
- Seniority: ${profile.seniority}
- Target TJM (EUR/day): min ${profile.tjm.min}, max ${profile.tjm.max}; flag as lowball below ${profile.tjm.lowballBelow}.
- Remote preference: ${profile.remotePreference}
- Disliked client types: ${killClients}
- Minimum acceptable duration: ${profile.minDurationMonths} months

WHAT IS A "REAL MISSION"
- A freelance / contract / mission posting from a hiring party.
- NOT a real mission: CDI / permanent roles, stage / alternance / apprentissage,
  "for hire" self-promo, agency mass-mailings, recycled calls without specifics.

SCORING RUBRIC (0–100)
- 80–100: Stack matches, day-rate in range or above, remote-first or Paris
  on-site, direct client or accepted client type, duration >= ${profile.minDurationMonths} months.
- 50–79: Partial stack match OR rate slightly below range OR hybrid / less
  preferred remote; still actionable.
- 20–49: Mismatch on stack, lowball rate, or disliked client type, but
  ambiguous enough to surface.
- 0–19: Clearly not a fit OR not a real mission.

EXAMPLES
- "[Hiring] Senior React/TS, 6 months, full remote, 600€/j, direct client" → score: 80, reason: "Stack match, in-range TJM, full remote, direct client."
- "Recherche freelance React 2 ans (mais en réalité CDI converti)" → score: 20, reason: "Disguised CDI."
`.trim();

  return strict ? `${base}\n\n${STRICT_RETRY_NOTE}` : base;
}

function buildUserMessage(c: PromptCandidate): string {
  return `Source: ${c.source}\nURL: ${c.url}\nTitle: ${c.title}\n\n---\n${c.body}\n---`;
}

export function buildScoringPrompt(
  c: PromptCandidate,
  profile: ScoringProfile,
  opts: { strict?: boolean } = {},
): BuiltPrompt {
  return {
    messages: [
      { role: "system", content: buildSystemPrompt(profile, opts.strict ?? false) },
      { role: "user", content: buildUserMessage(c) },
    ],
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/scoring/prompt.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/scoring/prompt.ts test/scoring/prompt.test.ts
git commit -m "feat: add scoring prompt builder with rubric and few-shot anchors"
```

---

## Task 5: AI client (with retry + neuron accounting)

**Files:**
- Create: `src/scoring/ai.ts`
- Test: `test/scoring/ai.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/scoring/ai.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { scoreCandidate, type AiLike, type AiResponse } from "../../src/scoring/ai";
import type { ScoringProfile } from "../../src/config";

const profile: ScoringProfile = {
  skills: ["react"],
  seniority: "senior",
  tjm: { min: 500, max: 700, lowballBelow: 450 },
  remotePreference: "remote-first",
  killClientTypes: [],
  minDurationMonths: 3,
};

const candidate = {
  source: "reddit",
  externalId: "p1",
  url: "https://x/p1",
  title: "[Hiring] Senior React, 6 mois, full remote, 600€/j",
  body: "Direct client.",
};

const goodArgs = {
  is_real_mission: true,
  rate_eur_per_day: 600,
  duration: "6 mois",
  remote: "full",
  location: null,
  skills: ["react"],
  client_type: "direct",
  score: 80,
  reason: "Stack + rate + remote.",
};

function aiReturning(responses: AiResponse[]): AiLike {
  let i = 0;
  return {
    run: vi.fn(async () => {
      const r = responses[Math.min(i, responses.length - 1)];
      i += 1;
      return r;
    }),
  };
}

afterEach(() => vi.restoreAllMocks());

describe("scoreCandidate", () => {
  it("returns parsed extraction + neurons on a successful tool-call", async () => {
    const ai = aiReturning([
      {
        tool_calls: [
          {
            function: { name: "extract_mission", arguments: JSON.stringify(goodArgs) },
          },
        ],
        usage: { neurons: 210 },
      },
    ]);
    const out = await scoreCandidate(ai, candidate, profile);
    expect(out.extraction.score).toBe(80);
    expect(out.neurons).toBe(210);
    expect(out.retried).toBe(false);
  });

  it("retries once with strict prompt on malformed first response, then succeeds", async () => {
    const ai = aiReturning([
      { response: "I cannot comply." } as AiResponse, // no tool_calls
      {
        tool_calls: [
          {
            function: { name: "extract_mission", arguments: JSON.stringify(goodArgs) },
          },
        ],
        usage: { neurons: 180 },
      },
    ]);
    const out = await scoreCandidate(ai, candidate, profile);
    expect(out.extraction.score).toBe(80);
    expect(out.retried).toBe(true);
    expect((ai.run as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
  });

  it("falls back to the configured guess when usage.neurons is absent", async () => {
    const ai = aiReturning([
      {
        tool_calls: [
          {
            function: { name: "extract_mission", arguments: JSON.stringify(goodArgs) },
          },
        ],
        // no usage field
      } as AiResponse,
    ]);
    const out = await scoreCandidate(ai, candidate, profile);
    expect(out.neurons).toBeGreaterThan(0); // the guess kicks in
  });

  it("throws ScoringFailedError after persistent malformed responses", async () => {
    const ai = aiReturning([
      { response: "nope" } as AiResponse,
      { response: "still nope" } as AiResponse,
    ]);
    await expect(scoreCandidate(ai, candidate, profile)).rejects.toMatchObject({
      name: "ScoringFailedError",
    });
  });

  it("counts neurons across BOTH calls when a retry happens", async () => {
    const ai = aiReturning([
      { response: "bad", usage: { neurons: 50 } } as AiResponse,
      {
        tool_calls: [
          {
            function: { name: "extract_mission", arguments: JSON.stringify(goodArgs) },
          },
        ],
        usage: { neurons: 200 },
      },
    ]);
    const out = await scoreCandidate(ai, candidate, profile);
    expect(out.neurons).toBe(250);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/scoring/ai.test.ts`
Expected: FAIL — `Cannot find module '../../src/scoring/ai'`.

- [ ] **Step 3: Write `src/scoring/ai.ts`**

```ts
import { AI_MODEL, NEURONS_PER_CALL_GUESS, type ScoringProfile } from "../config";
import { EXTRACTION_TOOL, parseExtraction, type Extraction } from "./schema";
import { buildScoringPrompt, type PromptCandidate } from "./prompt";

/** What we need from the Workers AI binding — narrowed so tests can fake it. */
export interface AiLike {
  run(
    model: string,
    input: {
      messages: Array<{ role: string; content: string }>;
      tools?: unknown[];
    },
  ): Promise<AiResponse>;
}

export interface AiResponse {
  response?: string;
  tool_calls?: Array<{
    function: { name: string; arguments: string };
  }>;
  usage?: { neurons?: number };
}

export interface ScoreResult {
  extraction: Extraction;
  neurons: number;
  retried: boolean;
}

export class ScoringFailedError extends Error {
  override name = "ScoringFailedError";
  constructor(
    message: string,
    public readonly lastRaw: string,
  ) {
    super(message);
  }
}

function extractToolArgs(res: AiResponse): string | null {
  const tc = res.tool_calls?.[0];
  if (!tc || tc.function?.name !== "extract_mission") return null;
  return tc.function.arguments;
}

function neuronsOf(res: AiResponse): number {
  const n = res.usage?.neurons;
  return typeof n === "number" && Number.isFinite(n) && n > 0
    ? n
    : NEURONS_PER_CALL_GUESS;
}

async function callOnce(
  ai: AiLike,
  c: PromptCandidate,
  profile: ScoringProfile,
  strict: boolean,
): Promise<{ res: AiResponse; extraction: Extraction | null; rawArgs: string }> {
  const { messages } = buildScoringPrompt(c, profile, { strict });
  const res = await ai.run(AI_MODEL, { messages, tools: [EXTRACTION_TOOL] });
  const args = extractToolArgs(res);
  if (!args) return { res, extraction: null, rawArgs: "" };
  try {
    const extraction = parseExtraction(JSON.parse(args));
    return { res, extraction, rawArgs: args };
  } catch {
    return { res, extraction: null, rawArgs: args };
  }
}

/**
 * Score one candidate. Calls the model with function-calling bound to the
 * extraction schema. On a malformed or missing tool-call, retries once with
 * a stricter system prompt. On a second failure throws ScoringFailedError so
 * the caller can mark the candidate as score-failed and move on.
 *
 * Neurons used across BOTH attempts are returned so the budget tracker sees
 * the true cost of a retry.
 */
export async function scoreCandidate(
  ai: AiLike,
  candidate: PromptCandidate,
  profile: ScoringProfile,
): Promise<ScoreResult> {
  const first = await callOnce(ai, candidate, profile, false);
  if (first.extraction) {
    return {
      extraction: first.extraction,
      neurons: neuronsOf(first.res),
      retried: false,
    };
  }

  const second = await callOnce(ai, candidate, profile, true);
  const totalNeurons = neuronsOf(first.res) + neuronsOf(second.res);

  if (second.extraction) {
    return {
      extraction: second.extraction,
      neurons: totalNeurons,
      retried: true,
    };
  }

  throw new ScoringFailedError(
    "model failed to produce a valid extraction after one retry",
    second.rawArgs || JSON.stringify(second.res).slice(0, 500),
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/scoring/ai.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/scoring/ai.ts test/scoring/ai.test.ts
git commit -m "feat: add scoreCandidate with function-calling, retry, and neuron accounting"
```

---

## Task 6: scoreTick pipeline

**Files:**
- Create: `src/pipeline/scoreTick.ts`
- Test: `test/pipeline/scoreTick.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/pipeline/scoreTick.test.ts`:

```ts
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runScoreTick } from "../../src/pipeline/scoreTick";
import { insertCandidates, recordRun } from "../../src/store/db";
import { getMissions } from "../../src/store/missions";
import { DAILY_NEURON_BUDGET } from "../../src/config";
import type { AiLike, AiResponse } from "../../src/scoring/ai";

beforeEach(async () => {
  await env.DB.exec("DELETE FROM missions");
  await env.DB.exec("DELETE FROM candidates");
  await env.DB.exec("DELETE FROM runs");
});

const NOW = new Date("2026-05-28T12:00:00.000Z");

function goodArgs(score = 80) {
  return {
    is_real_mission: true,
    rate_eur_per_day: 600,
    duration: "6 mois",
    remote: "full",
    location: null,
    skills: ["react"],
    client_type: "direct",
    score,
    reason: "ok",
  };
}

function toolResp(args: object, neurons = 200): AiResponse {
  return {
    tool_calls: [
      { function: { name: "extract_mission", arguments: JSON.stringify(args) } },
    ],
    usage: { neurons },
  };
}

function aiSequence(responses: AiResponse[]): AiLike {
  let i = 0;
  return {
    run: vi.fn(async () => responses[Math.min(i++, responses.length - 1)]),
  };
}

async function seedPending(count: number) {
  await insertCandidates(
    env.DB,
    Array.from({ length: count }, (_, i) => ({
      source: "reddit",
      externalId: `c${i}`,
      url: `https://x/${i}`,
      title: `[Hiring] React #${i}`,
      body: "6 mois, full remote, 600€/j.",
      tjm: 600,
      lowball: false,
    })),
  );
}

describe("runScoreTick", () => {
  it("scores a batch of pending candidates and writes missions", async () => {
    await seedPending(3);
    const ai = aiSequence([toolResp(goodArgs(80)), toolResp(goodArgs(70)), toolResp(goodArgs(40))]);

    const result = await runScoreTick(env, { ai, now: NOW });

    expect(result.scored).toBe(3);
    expect(result.failed).toBe(0);
    expect(result.deferred).toBe(false);
    const missions = await getMissions(env.DB, { limit: 10 });
    expect(missions).toHaveLength(3);
    expect(missions.map((m) => m.score).sort((a, b) => b - a)).toEqual([80, 70, 40]);
  });

  it("marks the candidate score-failed after persistent extraction failure", async () => {
    await seedPending(1);
    const ai: AiLike = {
      run: vi.fn(async () => ({ response: "garbage" }) as AiResponse),
    };
    const result = await runScoreTick(env, { ai, now: NOW });
    expect(result.scored).toBe(0);
    expect(result.failed).toBe(1);
    const row = await env.DB.prepare(
      "SELECT status FROM candidates WHERE external_id = ?",
    )
      .bind("c0")
      .first<{ status: string }>();
    expect(row?.status).toBe("score-failed");
    expect((await getMissions(env.DB, { limit: 10 }))).toHaveLength(0);
  });

  it("is a no-op when the daily budget is exhausted (defers to next day)", async () => {
    await seedPending(2);
    await recordRun(env.DB, {
      tick: "score",
      startedAt: "2026-05-28T03:00:00.000Z",
      stats: { neurons: DAILY_NEURON_BUDGET + 100 },
    });
    const ai: AiLike = { run: vi.fn() };
    const result = await runScoreTick(env, { ai, now: NOW });
    expect(result.deferred).toBe(true);
    expect(result.scored).toBe(0);
    expect(ai.run).not.toHaveBeenCalled();
    // Candidates remain pending.
    const row = await env.DB.prepare(
      "SELECT status FROM candidates WHERE external_id = 'c0'",
    ).first<{ status: string }>();
    expect(row?.status).toBe("pending");
  });

  it("isolates one bad candidate without killing the whole tick", async () => {
    await seedPending(3);
    const ai = aiSequence([
      toolResp(goodArgs(80)),
      { response: "nope" } as AiResponse, // first fail
      { response: "still nope" } as AiResponse, // retry fail
      toolResp(goodArgs(60)),
    ]);
    const result = await runScoreTick(env, { ai, now: NOW });
    expect(result.scored).toBe(2);
    expect(result.failed).toBe(1);
    const missions = await getMissions(env.DB, { limit: 10 });
    expect(missions.map((m) => m.score).sort((a, b) => b - a)).toEqual([80, 60]);
  });

  it("records the run with neurons spent so the next tick's budget is accurate", async () => {
    await seedPending(1);
    const ai = aiSequence([toolResp(goodArgs(50), 222)]);
    await runScoreTick(env, { ai, now: NOW });
    const row = await env.DB.prepare(
      "SELECT stats FROM runs WHERE tick = 'score' ORDER BY id DESC LIMIT 1",
    ).first<{ stats: string }>();
    const stats = JSON.parse(row!.stats);
    expect(stats.neurons).toBe(222);
    expect(stats.scored).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/pipeline/scoreTick.test.ts`
Expected: FAIL — `Cannot find module '../../src/pipeline/scoreTick'`.

- [ ] **Step 3: Write `src/pipeline/scoreTick.ts`**

```ts
import type { Env } from "../types/env";
import {
  MAX_BATCH,
  NEURONS_PER_CALL_GUESS,
  scoringProfile as defaultScoringProfile,
  type ScoringProfile,
} from "../config";
import {
  ScoringFailedError,
  scoreCandidate,
  type AiLike,
} from "../scoring/ai";
import { upsertMission } from "../store/missions";
import { recordRun } from "../store/db";
import { remainingBudget } from "../store/budget";

export interface ScoreTickOptions {
  ai?: AiLike;
  profile?: ScoringProfile;
  now?: Date;
}

export interface ScoreTickResult {
  scored: number;
  failed: number;
  deferred: boolean;
  neurons: number;
}

interface PendingRow {
  id: number;
  source: string;
  externalId: string;
  url: string;
  title: string;
  body: string;
}

export async function runScoreTick(
  env: Env,
  opts: ScoreTickOptions = {},
): Promise<ScoreTickResult> {
  const ai = opts.ai ?? (env.AI as unknown as AiLike);
  const profile = opts.profile ?? defaultScoringProfile;
  const now = opts.now ?? new Date();
  const startedAt = now.toISOString();

  const budget = await remainingBudget(env.DB, now);
  if (budget < NEURONS_PER_CALL_GUESS) {
    // Defer — record the no-op for visibility.
    await recordRun(env.DB, {
      tick: "score",
      startedAt,
      finishedAt: new Date().toISOString(),
      stats: { deferred: true, budget, neurons: 0, scored: 0, failed: 0 },
    });
    return { scored: 0, failed: 0, deferred: true, neurons: 0 };
  }

  const batchSize = Math.min(
    MAX_BATCH,
    Math.floor(budget / NEURONS_PER_CALL_GUESS),
  );

  const { results: pending } = await env.DB
    .prepare(
      `SELECT id, source, external_id AS externalId, url, title, body
         FROM candidates
        WHERE status = 'pending'
        ORDER BY fetched_at ASC, id ASC
        LIMIT ?`,
    )
    .bind(batchSize)
    .all<PendingRow>();

  let scored = 0;
  let failed = 0;
  let neurons = 0;

  for (const c of pending) {
    try {
      const { extraction, neurons: n } = await scoreCandidate(ai, c, profile);
      neurons += n;
      await env.DB.batch([
        env.DB
          .prepare(
            `INSERT INTO missions (
               candidate_id, source, url, title, is_real_mission, rate_eur_day,
               duration, remote, location, skills, client_type, score, reason,
               raw_response, first_seen, last_seen
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(candidate_id) DO UPDATE SET
               is_real_mission = excluded.is_real_mission,
               rate_eur_day    = excluded.rate_eur_day,
               duration        = excluded.duration,
               remote          = excluded.remote,
               location        = excluded.location,
               skills          = excluded.skills,
               client_type     = excluded.client_type,
               score           = excluded.score,
               reason          = excluded.reason,
               raw_response    = excluded.raw_response,
               last_seen       = excluded.last_seen`,
          )
          .bind(
            c.id,
            c.source,
            c.url,
            c.title,
            extraction.is_real_mission ? 1 : 0,
            extraction.rate_eur_per_day,
            extraction.duration,
            extraction.remote,
            extraction.location,
            JSON.stringify(extraction.skills),
            extraction.client_type,
            extraction.score,
            extraction.reason,
            JSON.stringify(extraction),
            new Date().toISOString(),
            new Date().toISOString(),
          ),
        env.DB
          .prepare("UPDATE candidates SET status = 'scored' WHERE id = ?")
          .bind(c.id),
      ]);
      scored += 1;
    } catch (err) {
      failed += 1;
      if (err instanceof ScoringFailedError) {
        neurons += NEURONS_PER_CALL_GUESS * 2; // attribute the cost of two failed calls
        await env.DB
          .prepare("UPDATE candidates SET status = 'score-failed' WHERE id = ?")
          .bind(c.id)
          .run();
        console.error("score-failed:", c.externalId, err.lastRaw.slice(0, 200));
      } else {
        // Unexpected — surface but don't mark candidate, so a transient
        // upstream blip lets this candidate retry next tick.
        console.error("score-tick error:", c.externalId, String(err));
      }
    }
  }

  await recordRun(env.DB, {
    tick: "score",
    startedAt,
    finishedAt: new Date().toISOString(),
    stats: { batchSize, scored, failed, neurons, deferred: false },
  });

  return { scored, failed, deferred: false, neurons };
}
```

> Note: the INSERT SQL is the same shape used by `upsertMission` in `store/missions.ts`. We could call `upsertMission` instead, but inlining inside `db.batch([…])` is what guarantees the mission row + the candidate-status update happen atomically — a single transaction. If either fails, neither lands, and the candidate stays `pending` for the next tick.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/pipeline/scoreTick.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/pipeline/scoreTick.ts test/pipeline/scoreTick.test.ts
git commit -m "feat: add score-tick pipeline with budget gating and atomic upsert"
```

---

## Task 7: API, dashboard, cron wiring, end-to-end

**Files:**
- Modify: `src/http/api.ts`, `src/index.ts`, `public/index.html`, `public/app.js`
- Modify (extend): `test/index.test.ts`

- [ ] **Step 1: Add the `/api/missions` route** in `src/http/api.ts`

Open the file and update it:

```ts
import type { Env } from "../types/env";
import { getCandidates, getRecentRuns, getStats } from "../store/db";
import { getMissions } from "../store/missions";
```

Then in the `switch (url.pathname)` block, add the missions case before the `default`:

```ts
      case "/api/missions": {
        const limit = parseLimit(url.searchParams.get("limit"));
        const minScore = Number(url.searchParams.get("minScore") ?? 0);
        const safeMinScore =
          Number.isFinite(minScore) && minScore >= 0 ? Math.min(minScore, 100) : 0;
        const missions = await getMissions(env.DB, { limit, minScore: safeMinScore });
        return json({ missions });
      }
```

- [ ] **Step 2: Extend the cron switch in `src/index.ts`**

```ts
import type { Env } from "./types/env";
import { handleApi } from "./http/api";
import { runFetchTick } from "./pipeline/fetchTick";
import { runScoreTick } from "./pipeline/scoreTick";

export default {
  async scheduled(
    controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    switch (controller.cron) {
      case "*/30 * * * *":
        ctx.waitUntil(runFetchTick(env));
        break;
      case "*/15 * * * *":
        ctx.waitUntil(runScoreTick(env));
        break;
      default:
        console.warn(`unhandled cron: ${controller.cron}`);
    }
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const apiResponse = await handleApi(request, env);
    if (apiResponse) return apiResponse;
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
```

- [ ] **Step 3: Add a missions section to `public/index.html`**

Insert a new section above the existing `#list` div. Replace the `<body>` contents with:

```html
    <h1>🎯 missions-free</h1>
    <div class="stats" id="stats"></div>

    <h2 style="font-size:1.1rem;margin-top:1.5rem">Missions</h2>
    <input id="qm" placeholder="Filtrer missions par titre…" />
    <label for="qm" class="sr-only">Filtrer missions par titre</label>
    <div id="missions"></div>

    <h2 style="font-size:1.1rem;margin-top:1.5rem">Candidats bruts</h2>
    <label for="q" class="sr-only">Filtrer par titre</label>
    <input id="q" placeholder="Filtrer par titre…" />
    <div id="list"></div>
    <script src="/app.js"></script>
```

Add one more rule to the `<style>` block (before `.sr-only`):

```css
      .score { font-weight: 700; padding: 0 .4rem; border-radius: 6px; }
      .score.hi { background: #1b4332; color: #95d5b2; }
      .score.mid { background: #3a2e10; color: #ffd166; }
      .score.lo { background: #3e1f1f; color: #ff9b9b; }
```

- [ ] **Step 4: Render missions in `public/app.js`**

Inside `load()`, after the stats render and before the `const list = ...` line, add the missions fetch + render:

```js
    const missionsRes = await fetch("/api/missions?limit=200");
    if (!missionsRes.ok) throw new Error(`api error: missions=${missionsRes.status}`);
    const { missions } = await missionsRes.json();

    const missionsEl = document.getElementById("missions");
    const scoreClass = (s) => (s >= 70 ? "hi" : s >= 40 ? "mid" : "lo");
    const renderMissions = (filter) => {
      const f = filter.trim().toLowerCase();
      missionsEl.innerHTML = missions
        .filter((m) => !f || m.title.toLowerCase().includes(f))
        .map((m) => {
          const tjm = m.rateEurDay
            ? `<span class="tjm">${escapeHtml(String(m.rateEurDay))}€/j</span> · `
            : "";
          const loc = m.location ? `${escapeHtml(m.location)} · ` : "";
          return `<div class="card">
              <span class="score ${scoreClass(m.score)}">${escapeHtml(String(m.score))}</span>
              <a href="${escapeHtml(safeUrl(m.url))}" target="_blank" rel="noopener">${escapeHtml(m.title)}</a>
              <div class="meta">${tjm}${escapeHtml(m.remote)} · ${escapeHtml(m.clientType)} · ${loc}${escapeHtml(m.reason || "")}</div>
            </div>`;
        })
        .join("");
    };
    document
      .getElementById("qm")
      .addEventListener("input", (e) => renderMissions(e.target.value));
    renderMissions("");
```

- [ ] **Step 5: Extend the integration test**

Open `test/index.test.ts` and replace its contents:

```ts
import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { insertCandidates } from "../src/store/db";
import { upsertMission } from "../src/store/missions";

beforeEach(async () => {
  await env.DB.exec("DELETE FROM missions");
  await env.DB.exec("DELETE FROM candidates");
});

describe("worker fetch routing", () => {
  it("serves /api/candidates from the worker", async () => {
    await insertCandidates(env.DB, [
      {
        source: "reddit",
        externalId: "a",
        url: "https://x/a",
        title: "React mission",
        body: "",
        tjm: 600,
        lowball: false,
      },
    ]);
    const res = await SELF.fetch("https://worker.test/api/candidates");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { candidates: unknown[] };
    expect(body.candidates).toHaveLength(1);
  });

  it("serves /api/missions from the worker, filtered by minScore", async () => {
    await insertCandidates(env.DB, [
      {
        source: "reddit",
        externalId: "a",
        url: "https://x/a",
        title: "React mission",
        body: "",
        tjm: 600,
        lowball: false,
      },
    ]);
    const candidateId = (
      await env.DB.prepare(
        "SELECT id FROM candidates WHERE external_id = 'a'",
      ).first<{ id: number }>()
    )!.id;
    await upsertMission(env.DB, {
      candidateId,
      source: "reddit",
      url: "https://x/a",
      title: "React mission",
      isRealMission: true,
      rateEurDay: 600,
      duration: "6 mois",
      remote: "full",
      location: null,
      skills: ["react"],
      clientType: "direct",
      score: 75,
      reason: "ok",
      rawResponse: "{}",
    });

    const all = await SELF.fetch("https://worker.test/api/missions");
    const allBody = (await all.json()) as { missions: Array<{ score: number }> };
    expect(allBody.missions).toHaveLength(1);
    expect(allBody.missions[0].score).toBe(75);

    const filtered = await SELF.fetch("https://worker.test/api/missions?minScore=80");
    const filteredBody = (await filtered.json()) as { missions: unknown[] };
    expect(filteredBody.missions).toHaveLength(0);
  });

  it("serves the dashboard HTML at /", async () => {
    const res = await SELF.fetch("https://worker.test/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("missions-free");
    expect(html).toContain("Missions"); // new section heading
  });

  it("falls through to ASSETS for non-API, non-asset paths", async () => {
    const res = await SELF.fetch("https://worker.test/unknown-path");
    expect(res.headers.get("content-type") ?? "").not.toContain("application/json");
    expect(res.status).not.toBe(200);
  });
});
```

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS. Total: **63 tests** (39 prior + 4 missions store + 5 budget + 5 schema + 5 prompt + 5 ai + 5 scoreTick − 0 + 1 new index integration). Paste the summary line.

If a count differs, that's fine as long as everything is green — verify against expected per-task counts.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: wire score cron, /api/missions, and dashboard missions view"
```

- [ ] **Step 8: (Optional) Manual smoke against real Workers AI**

Only when you want to validate French quality end-to-end (requires `npx wrangler login` + the live D1):

```bash
npx wrangler d1 migrations apply missions-free --remote
npm run dev   # in a separate terminal
# trigger fetch first, then score
curl "http://localhost:8787/__scheduled?cron=*/30+*+*+*+*"
curl "http://localhost:8787/__scheduled?cron=*/15+*+*+*+*"
curl "http://localhost:8787/api/missions"
```

`wrangler dev` defaults to local mode and won't actually hit Workers AI. Use `npx wrangler dev --remote` to exercise the real `env.AI`. Each scored candidate consumes ~200 Neurons of your 10,000/day allocation.

---

## Self-Review

After writing the plan, checking it against the spec:

**1. Spec coverage:**
- §1 Goal (score candidates → missions) → Tasks 1, 5, 6 ✓
- §2 Constraints (cron count, batch size, subrequests) → Task 0 cron + Task 6 batch math ✓
- §3 `score` tick stages → Task 6 ✓
- §4 Workers AI integration (model constant, function-calling, neurons) → Tasks 0, 3, 5 ✓
- §5 Budget tracking → Task 2 + Task 6 budget gate ✓
- §6 `missions` table + `candidates.status` extension → Task 0 migration ✓
- §7 New module layout → Files map matches §7 ✓
- §8 Error handling matrix → Task 5 retry, Task 6 isolation/atomic upsert/deferral ✓
- §9 Testing strategy (unit + integration with mocked AI) → Tasks 1–6 ✓
- §10 Free-tier budget (≤ ~26 subreq/tick) → Task 6 batch cap = 8 satisfies ✓
- §11 Phasing → Tasks 0–7 line up ✓
- §12 Risks (`usage.neurons` fallback) → Task 5 implements + tests the fallback ✓

**2. Placeholder scan:** No "TBD"/"TODO"/"implement later" present; every code step ships complete runnable code; commands and expected outputs are concrete.

**3. Type consistency:** `Extraction` (schema.ts) is consumed by `ai.ts` and `scoreTick.ts`. `MissionInput`/`MissionRow` (missions.ts) shape used in tests, `upsertMission`, and `scoreTick`'s inline INSERT (which mirrors the same column order). `AiLike` and `AiResponse` declared in `ai.ts`, imported by `scoreTick` tests. `ScoringProfile` declared in `config.ts`, consumed by `prompt.ts`, `ai.ts`, and `scoreTick.ts`. `Remote` / `ClientType` declared in `missions.ts`, re-imported by `schema.ts` (single source of truth). All consistent.

**4. Implementation note for the inline INSERT in `scoreTick`:** This duplicates the SQL in `upsertMission` deliberately — the goal is to run mission insert + candidate status update inside a single `db.batch([...])` (atomic D1 transaction). A future task could pull both into a single store function `recordScoredMission(db, mission, candidateId)` to remove the duplication; for M2a, the duplication is acknowledged and contained.
