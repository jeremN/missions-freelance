# missions-free — M1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a deployable Cloudflare Worker that, on a cron, fetches freelance posts from one sanctioned source (Reddit `r/forhire`), runs a deterministic pre-filter, stores survivors in D1, and exposes a JSON API + static dashboard to browse them — with zero AI cost.

**Architecture:** Single Worker with `scheduled()` (the `fetch` tick) and `fetch()` (JSON API + static assets). I/O is dependency-injected (`fetchJson` passed via `AdapterCtx`) so adapters and pipeline are unit-testable; D1 is the store, tested against a real local SQLite via `vitest-pool-workers`. Sources live behind a pluggable registry so M2 can add more without touching the pipeline.

**Tech Stack:** TypeScript, Cloudflare Workers, D1, Wrangler, Vitest + `@cloudflare/vitest-pool-workers`. No runtime dependencies (plain `fetch`, hand-rolled RSS/JSON parsing); dashboard is plain HTML/JS served from `public/`.

**Spec:** `docs/superpowers/specs/2026-05-27-missions-free-scanner-design.md` (M1 = §10 milestone M1).

---

## File Structure (M1)

```
package.json                      # scripts + devDeps
tsconfig.json
wrangler.jsonc                    # name, main, D1, assets, cron (fetch tick only)
vitest.config.ts                  # cloudflareTest() plugin + readD1Migrations
test/setup.ts                     # applyD1Migrations before tests
test/env.d.ts                     # ProvidedEnv typing for cloudflare:test
migrations/0001_init.sql          # candidates, source_state, runs
src/types/env.ts                  # Env interface (bindings)
src/config.ts                     # editable user profile
src/sources/types.ts             # RawMission, SourceAdapter, AdapterCtx, SourceState
src/sources/http.ts               # fetchJson: UA + backoff + conditional requests
src/sources/reddit.ts             # Reddit r/forhire adapter
src/sources/registry.ts           # enabled adapters
src/matching/prefilter.ts         # deterministic include/exclude/TJM gate
src/store/db.ts                   # D1 helpers (prepared statements)
src/pipeline/fetchTick.ts         # fetch → prefilter → store → record run
src/http/api.ts                   # handleApi(request, env): /api/candidates|stats|runs
src/index.ts                      # Worker entry: scheduled() + fetch() routing
public/index.html                 # dashboard (static)
public/app.js                     # dashboard client logic
```

**What M1 deliberately omits (later milestones):** `missions` table + Workers AI scoring (M2), additional sources (M2), Resend email + Cloudflare Access (M3), LinkedIn (M4).

**Execution order:** `src/sources/types.ts` (Task 2) is foundational — Tasks 1, 3, 4, and 5 import `RawMission`/`SourceState` from it. Therefore execute **Task 2 before Task 1**; the rest follow their listed order (0 → 2 → 1 → 3 → 4 → 5 → 6 → 7). The task *numbers* below are stable labels, not the execution sequence.

---

## Task 0: Project scaffold

**Files:**
- Create: `package.json`, `tsconfig.json`, `wrangler.jsonc`, `vitest.config.ts`, `test/setup.ts`, `test/env.d.ts`, `src/types/env.ts`, `migrations/0001_init.sql`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "missions-free",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "test": "vitest run",
    "test:watch": "vitest",
    "typegen": "wrangler types",
    "migrate:local": "wrangler d1 migrations apply missions-free --local",
    "migrate:remote": "wrangler d1 migrations apply missions-free --remote"
  },
  "devDependencies": {
    "@cloudflare/vitest-pool-workers": "latest",
    "typescript": "latest",
    "vitest": "latest",
    "wrangler": "latest"
  }
}
```

- [ ] **Step 2: Install dependencies**

Run: `npm install`
Expected: `node_modules/` created, no errors. (Resolves `latest` to current versions; commit the generated `package-lock.json`.)

- [ ] **Step 3: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "es2022",
    "module": "es2022",
    "moduleResolution": "bundler",
    "lib": ["es2022"],
    "types": ["@cloudflare/vitest-pool-workers"],
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "resolveJsonModule": true
  },
  "include": ["src", "test", "worker-configuration.d.ts"]
}
```

- [ ] **Step 4: Create `wrangler.jsonc`**

```jsonc
{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "missions-free",
  "main": "src/index.ts",
  "compatibility_date": "2026-05-27",
  "observability": { "enabled": true },
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "missions-free",
      "database_id": "local-dev",
      "migrations_dir": "migrations"
    }
  ],
  "assets": {
    "directory": "./public",
    "binding": "ASSETS",
    "not_found_handling": "none",
    "run_worker_first": ["/api/*"]
  },
  "triggers": {
    "crons": ["*/30 * * * *"]
  }
}
```

> `database_id` is `"local-dev"` for local dev/tests (Miniflare ignores it and uses local SQLite). Before the deploy step in Task 7, replace it with the real id from `wrangler d1 create`.

- [ ] **Step 5: Create `migrations/0001_init.sql`**

```sql
CREATE TABLE IF NOT EXISTS candidates (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  source       TEXT NOT NULL,
  external_id  TEXT NOT NULL,
  url          TEXT NOT NULL,
  title        TEXT NOT NULL,
  body         TEXT NOT NULL,
  posted_at    TEXT,
  fetched_at   TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',
  tjm          INTEGER,
  lowball      INTEGER NOT NULL DEFAULT 0,
  UNIQUE(source, external_id)
);
CREATE INDEX IF NOT EXISTS idx_candidates_status ON candidates(status);

CREATE TABLE IF NOT EXISTS source_state (
  source        TEXT PRIMARY KEY,
  etag          TEXT,
  last_modified TEXT,
  cursor        TEXT,
  last_run_at   TEXT
);

CREATE TABLE IF NOT EXISTS runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tick        TEXT NOT NULL,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  stats       TEXT
);
```

- [ ] **Step 6: Create `src/types/env.ts`**

```ts
export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
}
```

- [ ] **Step 7: Create `vitest.config.ts`**

> API note: `@cloudflare/vitest-pool-workers@0.16.x` (Vitest v4 era) removed the
> `./config` subpath and `defineWorkersConfig`. The current API is the
> `cloudflareTest()` plugin + `readD1Migrations`, both exported from the package
> root. Verify with `node --input-type=module -e "import('@cloudflare/vitest-pool-workers').then(m=>console.log(Object.keys(m)))"`.

```ts
import { defineConfig } from "vitest/config";
import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: { TEST_MIGRATIONS: migrations },
        },
      }),
    ],
    test: {
      setupFiles: ["./test/setup.ts"],
    },
  };
});
```

- [ ] **Step 8: Create `test/env.d.ts`**

```ts
import type { D1Migration } from "cloudflare:test";
import type { Env } from "../src/types/env";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {
    TEST_MIGRATIONS: D1Migration[];
  }
}
```

- [ ] **Step 9: Create `test/setup.ts`**

```ts
import { applyD1Migrations, env } from "cloudflare:test";

// Apply D1 migrations to the isolated local DB once before the test suite.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
```

- [ ] **Step 10: Add a temporary smoke test to prove the harness runs**

Create `test/smoke.test.ts`:

```ts
import { env } from "cloudflare:test";
import { expect, it } from "vitest";

it("has a migrated D1 with the candidates table", async () => {
  const row = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='candidates'"
  ).first<{ name: string }>();
  expect(row?.name).toBe("candidates");
});
```

- [ ] **Step 11: Run the smoke test**

Run: `npm test`
Expected: PASS — confirms Vitest, the Workers pool, D1 binding, and migrations all work.

- [ ] **Step 12: Generate binding types and commit**

Run: `npx wrangler types`
Then:

```bash
git add -A
git commit -m "chore: scaffold missions-free worker (d1, vitest, cron)"
```

---

## Task 1: D1 store helpers

**Files:**
- Create: `src/store/db.ts`
- Test: `test/store/db.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/store/db.test.ts`:

```ts
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  getCandidates,
  getSourceState,
  getStats,
  insertCandidates,
  recordRun,
  setSourceState,
} from "../../src/store/db";
import type { RawMission } from "../../src/sources/types";

const raw = (id: string, title = "React mission"): RawMission => ({
  source: "reddit",
  externalId: id,
  url: `https://reddit.com/${id}`,
  title,
  body: "Looking for a senior React freelancer.",
  postedAt: "2026-05-27T10:00:00.000Z",
});

beforeEach(async () => {
  await env.DB.exec("DELETE FROM candidates");
  await env.DB.exec("DELETE FROM source_state");
  await env.DB.exec("DELETE FROM runs");
});

describe("store/db", () => {
  it("inserts candidates and reads them back newest-first", async () => {
    const inserted = await insertCandidates(env.DB, [
      { ...raw("a"), tjm: 600, lowball: false },
      { ...raw("b"), tjm: null, lowball: false },
    ]);
    expect(inserted).toBe(2);

    const rows = await getCandidates(env.DB, { limit: 10 });
    expect(rows.map((r) => r.externalId).sort()).toEqual(["a", "b"]);
    expect(rows[0].status).toBe("pending");
  });

  it("dedupes on (source, external_id) without throwing", async () => {
    await insertCandidates(env.DB, [{ ...raw("dup"), tjm: null, lowball: false }]);
    const second = await insertCandidates(env.DB, [
      { ...raw("dup"), tjm: null, lowball: false },
      { ...raw("new"), tjm: null, lowball: false },
    ]);
    expect(second).toBe(1); // only "new" is added
    const rows = await getCandidates(env.DB, { limit: 10 });
    expect(rows).toHaveLength(2);
  });

  it("round-trips source state", async () => {
    await setSourceState(env.DB, {
      source: "reddit",
      etag: 'W/"abc"',
      lastRunAt: "2026-05-27T10:00:00.000Z",
    });
    const state = await getSourceState(env.DB, "reddit");
    expect(state?.etag).toBe('W/"abc"');
  });

  it("records a run and reports stats", async () => {
    await insertCandidates(env.DB, [{ ...raw("a"), tjm: null, lowball: false }]);
    await recordRun(env.DB, {
      tick: "fetch",
      startedAt: "2026-05-27T10:00:00.000Z",
      finishedAt: "2026-05-27T10:00:01.000Z",
      stats: { fetched: 5, inserted: 1 },
    });
    const stats = await getStats(env.DB);
    expect(stats.totalCandidates).toBe(1);
    expect(stats.totalRuns).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/store/db.test.ts`
Expected: FAIL — `Cannot find module '../../src/store/db'`.

- [ ] **Step 3: Write `src/store/db.ts`**

```ts
import type { RawMission, SourceState } from "../sources/types";

export interface CandidateInput extends RawMission {
  tjm: number | null;
  lowball: boolean;
}

export interface CandidateRow extends CandidateInput {
  id: number;
  fetchedAt: string;
  status: string;
}

export interface RunInput {
  tick: string;
  startedAt: string;
  finishedAt?: string;
  stats?: unknown;
}

export interface Stats {
  totalCandidates: number;
  pending: number;
  totalRuns: number;
}

/** Insert candidates, ignoring duplicates on (source, external_id). Returns rows added. */
export async function insertCandidates(
  db: D1Database,
  items: CandidateInput[],
): Promise<number> {
  if (items.length === 0) return 0;
  const now = new Date().toISOString();
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO candidates
       (source, external_id, url, title, body, posted_at, fetched_at, status, tjm, lowball)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
  );
  const batch = items.map((i) =>
    stmt.bind(
      i.source,
      i.externalId,
      i.url,
      i.title,
      i.body,
      i.postedAt ?? null,
      now,
      i.tjm,
      i.lowball ? 1 : 0,
    ),
  );
  const results = await db.batch(batch);
  return results.reduce((sum, r) => sum + (r.meta.changes ?? 0), 0);
}

export async function getCandidates(
  db: D1Database,
  opts: { limit?: number; status?: string } = {},
): Promise<CandidateRow[]> {
  const limit = Math.min(opts.limit ?? 100, 500);
  const where = opts.status ? "WHERE status = ?" : "";
  const stmt = db.prepare(
    `SELECT id, source, external_id AS externalId, url, title, body,
            posted_at AS postedAt, fetched_at AS fetchedAt, status,
            tjm, lowball
       FROM candidates ${where}
       ORDER BY fetched_at DESC, id DESC
       LIMIT ?`,
  );
  const bound = opts.status ? stmt.bind(opts.status, limit) : stmt.bind(limit);
  const { results } = await bound.all<CandidateRow & { lowball: number }>();
  return results.map((r) => ({ ...r, lowball: Boolean(r.lowball) }));
}

export async function getSourceState(
  db: D1Database,
  source: string,
): Promise<SourceState | null> {
  const row = await db
    .prepare(
      `SELECT source, etag, last_modified AS lastModified, cursor, last_run_at AS lastRunAt
         FROM source_state WHERE source = ?`,
    )
    .bind(source)
    .first<SourceState>();
  return row ?? null;
}

export async function setSourceState(
  db: D1Database,
  state: SourceState,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO source_state (source, etag, last_modified, cursor, last_run_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(source) DO UPDATE SET
         etag = excluded.etag,
         last_modified = excluded.last_modified,
         cursor = excluded.cursor,
         last_run_at = excluded.last_run_at`,
    )
    .bind(
      state.source,
      state.etag ?? null,
      state.lastModified ?? null,
      state.cursor ?? null,
      state.lastRunAt ?? null,
    )
    .run();
}

export async function recordRun(db: D1Database, run: RunInput): Promise<void> {
  await db
    .prepare(
      `INSERT INTO runs (tick, started_at, finished_at, stats) VALUES (?, ?, ?, ?)`,
    )
    .bind(
      run.tick,
      run.startedAt,
      run.finishedAt ?? null,
      run.stats ? JSON.stringify(run.stats) : null,
    )
    .run();
}

export async function getStats(db: D1Database): Promise<Stats> {
  const [cand, pending, runs] = await db.batch([
    db.prepare("SELECT COUNT(*) AS n FROM candidates"),
    db.prepare("SELECT COUNT(*) AS n FROM candidates WHERE status = 'pending'"),
    db.prepare("SELECT COUNT(*) AS n FROM runs"),
  ]);
  const n = (r: D1Result) =>
    Number((r.results?.[0] as { n: number } | undefined)?.n ?? 0);
  return { totalCandidates: n(cand), pending: n(pending), totalRuns: n(runs) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/store/db.test.ts`
Expected: PASS (4 tests). If `meta.changes` is undefined for `INSERT OR IGNORE` duplicates in your runtime, the dedupe test still passes because ignored rows report `changes: 0`.

- [ ] **Step 5: Commit**

```bash
git add src/store/db.ts test/store/db.test.ts
git commit -m "feat: add D1 store helpers for candidates, source state, runs"
```

---

## Task 2: Source adapter types + HTTP helper

**Files:**
- Create: `src/sources/types.ts`, `src/sources/http.ts`
- Test: `test/sources/http.test.ts`

- [ ] **Step 1: Create `src/sources/types.ts`** (no test — pure type declarations)

```ts
export interface RawMission {
  source: string;
  externalId: string;
  url: string;
  title: string;
  body: string;
  postedAt?: string;
}

export interface SourceState {
  source: string;
  etag?: string | null;
  lastModified?: string | null;
  cursor?: string | null;
  lastRunAt?: string | null;
}

export interface FetchResult<T> {
  data: T | null;
  etag?: string;
  lastModified?: string;
  notModified: boolean;
}

export interface AdapterCtx {
  state: SourceState | null;
  fetchJson: <T>(
    url: string,
    opts?: { etag?: string | null; lastModified?: string | null },
  ) => Promise<FetchResult<T>>;
}

export interface SourceAdapter {
  id: string;
  enabled: boolean;
  fetch(ctx: AdapterCtx): Promise<RawMission[]>;
}
```

- [ ] **Step 2: Write the failing test for the HTTP helper**

Create `test/sources/http.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFetchJson } from "../../src/sources/http";

afterEach(() => vi.restoreAllMocks());

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    ...init,
  });
}

describe("createFetchJson", () => {
  it("sends a descriptive User-Agent and parses JSON", async () => {
    const fetchMock = vi.fn(async (_url, init?: RequestInit) => {
      expect(String((init?.headers as Record<string, string>)["User-Agent"])).toContain(
        "missions-free",
      );
      return jsonResponse({ ok: true }, { headers: { etag: 'W/"v1"' } });
    });
    const fetchJson = createFetchJson({ fetchImpl: fetchMock as typeof fetch, baseDelayMs: 0 });

    const res = await fetchJson<{ ok: boolean }>("https://api.example/x");
    expect(res.data).toEqual({ ok: true });
    expect(res.etag).toBe('W/"v1"');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns notModified on 304 without parsing a body", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 304 }));
    const fetchJson = createFetchJson({ fetchImpl: fetchMock as typeof fetch, baseDelayMs: 0 });

    const res = await fetchJson("https://api.example/x", { etag: 'W/"v1"' });
    expect(res.notModified).toBe(true);
    expect(res.data).toBeNull();
  });

  it("retries on 429 honoring Retry-After, then succeeds", async () => {
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        return new Response("rate limited", {
          status: 429,
          headers: { "retry-after": "0" },
        });
      }
      return jsonResponse({ ok: true });
    });
    const fetchJson = createFetchJson({ fetchImpl: fetchMock as typeof fetch, baseDelayMs: 0 });

    const res = await fetchJson<{ ok: boolean }>("https://api.example/x");
    expect(calls).toBe(2);
    expect(res.data).toEqual({ ok: true });
  });

  it("throws after exhausting retries on persistent 403", async () => {
    const fetchMock = vi.fn(async () => new Response("blocked", { status: 403 }));
    const fetchJson = createFetchJson({
      fetchImpl: fetchMock as typeof fetch,
      baseDelayMs: 0,
      maxRetries: 2,
    });

    await expect(fetchJson("https://api.example/x")).rejects.toThrow(/403/);
    expect(fetchMock).toHaveBeenCalledTimes(3); // initial + 2 retries
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- test/sources/http.test.ts`
Expected: FAIL — `Cannot find module '../../src/sources/http'`.

- [ ] **Step 4: Write `src/sources/http.ts`**

```ts
import type { FetchResult } from "./types";

const USER_AGENT =
  "missions-free/0.1 (+https://github.com/; personal freelance-mission radar)";

export interface FetchJsonDeps {
  fetchImpl?: typeof fetch;
  baseDelayMs?: number;
  maxRetries?: number;
}

export type FetchJson = <T>(
  url: string,
  opts?: { etag?: string | null; lastModified?: string | null },
) => Promise<FetchResult<T>>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Build a conditional, rate-limit-respecting JSON fetcher. */
export function createFetchJson(deps: FetchJsonDeps = {}): FetchJson {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const baseDelayMs = deps.baseDelayMs ?? 800;
  const maxRetries = deps.maxRetries ?? 3;

  return async function fetchJson<T>(url, opts = {}) {
    const headers: Record<string, string> = {
      "User-Agent": USER_AGENT,
      Accept: "application/json",
    };
    if (opts.etag) headers["If-None-Match"] = opts.etag;
    if (opts.lastModified) headers["If-Modified-Since"] = opts.lastModified;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const res = await fetchImpl(url, { headers });

      if (res.status === 304) {
        return { data: null, notModified: true };
      }
      if (res.ok) {
        const data = (await res.json()) as T;
        return {
          data,
          etag: res.headers.get("etag") ?? undefined,
          lastModified: res.headers.get("last-modified") ?? undefined,
          notModified: false,
        };
      }

      const retryable = res.status === 429 || res.status === 403 || res.status >= 500;
      if (!retryable || attempt === maxRetries) {
        throw new Error(`fetch ${url} failed: HTTP ${res.status}`);
      }

      const retryAfter = Number(res.headers.get("retry-after"));
      const delay = Number.isFinite(retryAfter)
        ? retryAfter * 1000
        : baseDelayMs * 2 ** attempt;
      await sleep(delay);
    }
    // Unreachable, but satisfies the type checker.
    throw new Error(`fetch ${url} failed: retries exhausted`);
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- test/sources/http.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add src/sources/types.ts src/sources/http.ts test/sources/http.test.ts
git commit -m "feat: add source adapter types and conditional rate-limited fetch helper"
```

---

## Task 3: Reddit adapter

**Files:**
- Create: `src/sources/reddit.ts`
- Test: `test/sources/reddit.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/sources/reddit.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { redditAdapter } from "../../src/sources/reddit";
import type { AdapterCtx, FetchResult } from "../../src/sources/types";

function ctxReturning(listing: unknown): AdapterCtx {
  return {
    state: null,
    fetchJson: vi.fn(async (): Promise<FetchResult<unknown>> => ({
      data: listing,
      etag: 'W/"abc"',
      notModified: false,
    })),
  };
}

const listing = {
  data: {
    children: [
      {
        data: {
          id: "p1",
          title: "[Hiring] Senior React/TS freelancer, remote, 600€/j",
          selftext: "3 month mission, fully remote.",
          permalink: "/r/forhire/comments/p1/x/",
          created_utc: 1748340000,
        },
      },
      {
        data: {
          id: "p2",
          title: "[For Hire] I am a designer looking for work",
          selftext: "Hire me!",
          permalink: "/r/forhire/comments/p2/y/",
          created_utc: 1748340500,
        },
      },
    ],
  },
};

describe("redditAdapter", () => {
  it("maps only [Hiring] posts to RawMission", async () => {
    const out = await redditAdapter.fetch(ctxReturning(listing));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      source: "reddit",
      externalId: "p1",
      url: "https://www.reddit.com/r/forhire/comments/p1/x/",
      title: expect.stringContaining("Senior React"),
    });
    expect(out[0].postedAt).toBe(new Date(1748340000 * 1000).toISOString());
  });

  it("returns [] when the feed is unchanged (304)", async () => {
    const ctx: AdapterCtx = {
      state: { source: "reddit", etag: 'W/"abc"' },
      fetchJson: vi.fn(async () => ({ data: null, notModified: true })),
    };
    const out = await redditAdapter.fetch(ctx);
    expect(out).toEqual([]);
  });

  it("passes the stored etag to fetchJson", async () => {
    const fetchJson = vi.fn(async () => ({ data: listing, notModified: false }));
    await redditAdapter.fetch({ state: { source: "reddit", etag: 'W/"e"' }, fetchJson });
    expect(fetchJson).toHaveBeenCalledWith(expect.stringContaining("reddit.com"), {
      etag: 'W/"e"',
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/sources/reddit.test.ts`
Expected: FAIL — `Cannot find module '../../src/sources/reddit'`.

- [ ] **Step 3: Write `src/sources/reddit.ts`**

```ts
import type { AdapterCtx, RawMission, SourceAdapter } from "./types";

const FEED_URL = "https://www.reddit.com/r/forhire/new.json?limit=50";

interface RedditListing {
  data: {
    children: Array<{
      data: {
        id: string;
        title: string;
        selftext: string;
        permalink: string;
        created_utc: number;
      };
    }>;
  };
}

export const redditAdapter: SourceAdapter = {
  id: "reddit",
  enabled: true,

  async fetch(ctx: AdapterCtx): Promise<RawMission[]> {
    const res = await ctx.fetchJson<RedditListing>(FEED_URL, {
      etag: ctx.state?.etag,
    });
    if (res.notModified || !res.data) return [];

    return res.data.data.children
      .map((c) => c.data)
      .filter((p) => p.title.trim().toLowerCase().startsWith("[hiring]"))
      .map((p) => ({
        source: "reddit",
        externalId: p.id,
        url: `https://www.reddit.com${p.permalink}`,
        title: p.title,
        body: p.selftext ?? "",
        postedAt: new Date(p.created_utc * 1000).toISOString(),
      }));
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/sources/reddit.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/sources/reddit.ts test/sources/reddit.test.ts
git commit -m "feat: add reddit r/forhire source adapter"
```

---

## Task 4: Config + pre-filter

**Files:**
- Create: `src/config.ts`, `src/matching/prefilter.ts`
- Test: `test/matching/prefilter.test.ts`

- [ ] **Step 1: Create `src/config.ts`** (no test — editable data)

```ts
export interface Profile {
  skills: string[];
  hardKill: string[];
  tjm: { lowballBelow: number };
}

export const profile: Profile = {
  skills: ["typescript", "react", "svelte", "node", "cloudflare", "javascript"],
  hardKill: ["cdi", "stage", "alternance", "apprentissage", "for hire"],
  tjm: { lowballBelow: 450 },
};
```

- [ ] **Step 2: Write the failing test**

Create `test/matching/prefilter.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { prefilter } from "../../src/matching/prefilter";
import type { RawMission } from "../../src/sources/types";

const profile = {
  skills: ["react", "typescript"],
  hardKill: ["cdi", "alternance"],
  tjm: { lowballBelow: 450 },
};

const mission = (over: Partial<RawMission>): RawMission => ({
  source: "reddit",
  externalId: "x",
  url: "https://x",
  title: "",
  body: "",
  ...over,
});

describe("prefilter", () => {
  it("passes a post matching a skill", () => {
    const r = prefilter(mission({ title: "Senior React developer needed" }), profile);
    expect(r.passed).toBe(true);
  });

  it("rejects when no skill matches", () => {
    const r = prefilter(mission({ title: "COBOL mainframe specialist" }), profile);
    expect(r.passed).toBe(false);
    expect(r.reasons).toContain("no-skill-match");
  });

  it("rejects on a hard-kill term even if a skill matches", () => {
    const r = prefilter(
      mission({ title: "React developer", body: "Poste en CDI à Lyon" }),
      profile,
    );
    expect(r.passed).toBe(false);
    expect(r.reasons).toContain("hard-kill:cdi");
  });

  it("is accent- and case-insensitive", () => {
    const r = prefilter(mission({ title: "Développeur REACT (typescript)" }), profile);
    expect(r.passed).toBe(true);
  });

  it("extracts TJM and flags lowball", () => {
    const r = prefilter(
      mission({ title: "React mission", body: "Budget: 350€/jour" }),
      profile,
    );
    expect(r.tjm).toBe(350);
    expect(r.lowball).toBe(true);
  });

  it("extracts TJM without lowball flag when above threshold", () => {
    const r = prefilter(
      mission({ title: "React mission", body: "TJM 600 EUR" }),
      profile,
    );
    expect(r.tjm).toBe(600);
    expect(r.lowball).toBe(false);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- test/matching/prefilter.test.ts`
Expected: FAIL — `Cannot find module '../../src/matching/prefilter'`.

- [ ] **Step 4: Write `src/matching/prefilter.ts`**

```ts
import type { RawMission } from "../sources/types";

export interface PrefilterProfile {
  skills: string[];
  hardKill: string[];
  tjm: { lowballBelow: number };
}

export interface PrefilterResult {
  passed: boolean;
  reasons: string[];
  tjm: number | null;
  lowball: boolean;
}

/** Lowercase + strip diacritics so "Développeur" matches "developpeur". */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

/** Find the first day-rate figure in EUR, if any. */
function extractTjm(text: string): number | null {
  // Matches "600€/j", "600 EUR/jour", "TJM 600", "350€/jour".
  const re = /(?:tjm\s*:?\s*)?(\d{2,4})\s*(?:€|eur|euros?)\s*(?:\/?\s*(?:j|jour|jr|day|d))?/i;
  const m = text.match(re);
  return m ? Number(m[1]) : null;
}

export function prefilter(
  m: RawMission,
  profile: PrefilterProfile,
): PrefilterResult {
  const haystack = normalize(`${m.title}\n${m.body}`);
  const reasons: string[] = [];

  for (const term of profile.hardKill) {
    if (haystack.includes(normalize(term))) reasons.push(`hard-kill:${term}`);
  }

  const matchedSkill = profile.skills.some((s) => haystack.includes(normalize(s)));
  if (!matchedSkill) reasons.push("no-skill-match");

  const tjm = extractTjm(`${m.title} ${m.body}`);
  const lowball = tjm !== null && tjm < profile.tjm.lowballBelow;

  return { passed: reasons.length === 0, reasons, tjm, lowball };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- test/matching/prefilter.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
git add src/config.ts src/matching/prefilter.ts test/matching/prefilter.test.ts
git commit -m "feat: add profile config and deterministic pre-filter"
```

---

## Task 5: Source registry + fetch tick

**Files:**
- Create: `src/sources/registry.ts`, `src/pipeline/fetchTick.ts`
- Test: `test/pipeline/fetchTick.test.ts`

- [ ] **Step 1: Create `src/sources/registry.ts`** (no test — trivial wiring)

```ts
import { redditAdapter } from "./reddit";
import type { SourceAdapter } from "./types";

export const adapters: SourceAdapter[] = [redditAdapter];

export function enabledAdapters(): SourceAdapter[] {
  return adapters.filter((a) => a.enabled);
}
```

- [ ] **Step 2: Write the failing test**

Create `test/pipeline/fetchTick.test.ts`:

```ts
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runFetchTick } from "../../src/pipeline/fetchTick";
import { getCandidates, getSourceState } from "../../src/store/db";
import type { SourceAdapter } from "../../src/sources/types";

beforeEach(async () => {
  await env.DB.exec("DELETE FROM candidates");
  await env.DB.exec("DELETE FROM source_state");
  await env.DB.exec("DELETE FROM runs");
});

const stubAdapter = (rows: number): SourceAdapter => ({
  id: "stub",
  enabled: true,
  fetch: vi.fn(async () =>
    Array.from({ length: rows }, (_, i) => ({
      source: "stub",
      externalId: `id-${i}`,
      url: `https://x/${i}`,
      title: i === 0 ? "Senior React mission, 600€/j" : "COBOL mainframe role",
      body: "",
    })),
  ),
});

describe("runFetchTick", () => {
  it("stores only pre-filter survivors and records a run", async () => {
    const adapter = stubAdapter(2); // 1 React (passes), 1 COBOL (rejected)
    const result = await runFetchTick(env, {
      adapters: [adapter],
      profile: {
        skills: ["react"],
        hardKill: ["cdi"],
        tjm: { lowballBelow: 450 },
      },
    });

    expect(result.fetched).toBe(2);
    expect(result.inserted).toBe(1);

    const rows = await getCandidates(env.DB, { limit: 10 });
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toContain("React");
    expect(rows[0].tjm).toBe(600);
  });

  it("persists source state (lastRunAt) after a run", async () => {
    await runFetchTick(env, {
      adapters: [stubAdapter(1)],
      profile: { skills: ["react"], hardKill: [], tjm: { lowballBelow: 450 } },
    });
    const state = await getSourceState(env.DB, "stub");
    expect(state?.lastRunAt).toBeTruthy();
  });

  it("does not crash the whole tick if one adapter throws", async () => {
    const bad: SourceAdapter = {
      id: "bad",
      enabled: true,
      fetch: vi.fn(async () => {
        throw new Error("boom");
      }),
    };
    const result = await runFetchTick(env, {
      adapters: [bad, stubAdapter(1)],
      profile: { skills: ["react"], hardKill: [], tjm: { lowballBelow: 450 } },
    });
    expect(result.errors).toBe(1);
    expect(result.inserted).toBe(1);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- test/pipeline/fetchTick.test.ts`
Expected: FAIL — `Cannot find module '../../src/pipeline/fetchTick'`.

- [ ] **Step 4: Write `src/pipeline/fetchTick.ts`**

```ts
import type { Env } from "../types/env";
import type { PrefilterProfile } from "../matching/prefilter";
import { prefilter } from "../matching/prefilter";
import { createFetchJson } from "../sources/http";
import { enabledAdapters } from "../sources/registry";
import type { SourceAdapter } from "../sources/types";
import {
  insertCandidates,
  getSourceState,
  recordRun,
  setSourceState,
  type CandidateInput,
} from "../store/db";
import { profile as defaultProfile } from "../config";

export interface FetchTickOptions {
  adapters?: SourceAdapter[];
  profile?: PrefilterProfile;
}

export interface FetchTickResult {
  fetched: number;
  inserted: number;
  errors: number;
}

export async function runFetchTick(
  env: Env,
  opts: FetchTickOptions = {},
): Promise<FetchTickResult> {
  const adapters = opts.adapters ?? enabledAdapters();
  const profile = opts.profile ?? defaultProfile;
  const fetchJson = createFetchJson();
  const startedAt = new Date().toISOString();

  let fetched = 0;
  let errors = 0;
  const survivors: CandidateInput[] = [];

  for (const adapter of adapters) {
    try {
      const state = await getSourceState(env.DB, adapter.id);
      const raw = await adapter.fetch({ state, fetchJson });
      fetched += raw.length;

      for (const m of raw) {
        const pf = prefilter(m, profile);
        if (pf.passed) {
          survivors.push({ ...m, tjm: pf.tjm, lowball: pf.lowball });
        }
      }

      await setSourceState(env.DB, {
        source: adapter.id,
        lastRunAt: new Date().toISOString(),
      });
    } catch (err) {
      errors += 1;
      console.error(`adapter ${adapter.id} failed:`, err);
    }
  }

  const inserted = await insertCandidates(env.DB, survivors);

  await recordRun(env.DB, {
    tick: "fetch",
    startedAt,
    finishedAt: new Date().toISOString(),
    stats: { fetched, inserted, errors, adapters: adapters.length },
  });

  return { fetched, inserted, errors };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- test/pipeline/fetchTick.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add src/sources/registry.ts src/pipeline/fetchTick.ts test/pipeline/fetchTick.test.ts
git commit -m "feat: add source registry and fetch-tick pipeline"
```

---

## Task 6: JSON API

**Files:**
- Create: `src/http/api.ts`
- Test: `test/http/api.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/http/api.test.ts`:

```ts
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { handleApi } from "../../src/http/api";
import { insertCandidates, recordRun } from "../../src/store/db";

beforeEach(async () => {
  await env.DB.exec("DELETE FROM candidates");
  await env.DB.exec("DELETE FROM runs");
});

const req = (path: string) => new Request(`https://worker.test${path}`);

describe("handleApi", () => {
  it("returns null for non-API paths (so assets can handle them)", async () => {
    const res = await handleApi(req("/index.html"), env);
    expect(res).toBeNull();
  });

  it("GET /api/candidates returns stored candidates as JSON", async () => {
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
    const res = await handleApi(req("/api/candidates"), env);
    expect(res?.status).toBe(200);
    expect(res?.headers.get("content-type")).toContain("application/json");
    const body = (await res!.json()) as { candidates: Array<{ externalId: string }> };
    expect(body.candidates[0].externalId).toBe("a");
  });

  it("GET /api/stats returns counts", async () => {
    await recordRun(env.DB, { tick: "fetch", startedAt: new Date().toISOString() });
    const res = await handleApi(req("/api/stats"), env);
    const body = (await res!.json()) as { totalRuns: number };
    expect(body.totalRuns).toBe(1);
  });

  it("unknown /api/* path returns 404 JSON", async () => {
    const res = await handleApi(req("/api/nope"), env);
    expect(res?.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/http/api.test.ts`
Expected: FAIL — `Cannot find module '../../src/http/api'`.

- [ ] **Step 3: Write `src/http/api.ts`**

```ts
import type { Env } from "../types/env";
import { getCandidates, getStats } from "../store/db";

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

/**
 * Handle /api/* routes. Returns null for non-API paths so the caller can
 * fall through to static assets.
 */
export async function handleApi(
  request: Request,
  env: Env,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/")) return null;

  switch (url.pathname) {
    case "/api/candidates": {
      const limit = Number(url.searchParams.get("limit") ?? 100);
      const candidates = await getCandidates(env.DB, { limit });
      return json({ candidates });
    }
    case "/api/stats": {
      return json(await getStats(env.DB));
    }
    default:
      return json({ error: "not_found" }, 404);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/http/api.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/http/api.ts test/http/api.test.ts
git commit -m "feat: add JSON API for candidates and stats"
```

---

## Task 7: Worker entry, dashboard, end-to-end verification

**Files:**
- Create: `src/index.ts`, `public/index.html`, `public/app.js`
- Test: `test/index.test.ts`
- Delete: `test/smoke.test.ts` (superseded)

- [ ] **Step 1: Write the failing integration test**

Create `test/index.test.ts`:

```ts
import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { insertCandidates } from "../src/store/db";

beforeEach(async () => {
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

  it("serves the dashboard HTML at /", async () => {
    const res = await SELF.fetch("https://worker.test/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("missions-free");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/index.test.ts`
Expected: FAIL. (Task 0 left a placeholder `src/index.ts` that returns `"ok"` for every request, so the assertions on JSON `/api/candidates` and the HTML dashboard will fail. You will overwrite that placeholder in Step 3.)

- [ ] **Step 3: Write `src/index.ts`** (overwrites the Task 0 placeholder)

```ts
import type { Env } from "./types/env";
import { handleApi } from "./http/api";
import { runFetchTick } from "./pipeline/fetchTick";

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

- [ ] **Step 4: Create `public/index.html`**

```html
<!DOCTYPE html>
<html lang="fr">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>missions-free</title>
    <style>
      :root { color-scheme: dark; }
      body { font-family: -apple-system, system-ui, sans-serif; margin: 0;
             background: #0c0a1a; color: #e8e4f0; padding: 1.5rem; }
      h1 { font-size: 1.4rem; }
      .stats { display: flex; gap: .75rem; flex-wrap: wrap; margin-bottom: 1rem; }
      .stat { background: #1a1530; border-radius: 10px; padding: .75rem 1rem; }
      .stat .v { font-size: 1.5rem; font-weight: 700; }
      .stat .l { font-size: .75rem; color: #9890aa; }
      input { width: 100%; padding: .6rem; border-radius: 8px; border: 1px solid #2a2440;
              background: #14102a; color: inherit; margin-bottom: 1rem; box-sizing: border-box; }
      .card { background: #14102a; border: 1px solid #221c3a; border-radius: 10px;
              padding: .8rem 1rem; margin-bottom: .6rem; }
      .card a { color: #8aa9ff; text-decoration: none; font-weight: 600; }
      .meta { font-size: .8rem; color: #9890aa; margin-top: .3rem; }
      .tjm { color: #6bcb77; } .low { color: #ff6b6b; }
    </style>
  </head>
  <body>
    <h1>🎯 missions-free</h1>
    <div class="stats" id="stats"></div>
    <input id="q" placeholder="Filtrer par titre…" />
    <div id="list"></div>
    <script src="/app.js"></script>
  </body>
</html>
```

- [ ] **Step 5: Create `public/app.js`**

```js
async function load() {
  const [statsRes, candRes] = await Promise.all([
    fetch("/api/stats"),
    fetch("/api/candidates?limit=200"),
  ]);
  const stats = await statsRes.json();
  const { candidates } = await candRes.json();

  document.getElementById("stats").innerHTML = [
    ["Candidats", stats.totalCandidates],
    ["En attente", stats.pending],
    ["Scans", stats.totalRuns],
  ]
    .map(([l, v]) => `<div class="stat"><div class="v">${v}</div><div class="l">${l}</div></div>`)
    .join("");

  const list = document.getElementById("list");
  const render = (filter) => {
    const f = filter.trim().toLowerCase();
    list.innerHTML = candidates
      .filter((c) => !f || c.title.toLowerCase().includes(f))
      .map((c) => {
        const tjm = c.tjm
          ? `<span class="${c.lowball ? "low" : "tjm"}">${c.tjm}€/j</span> · `
          : "";
        return `<div class="card">
            <a href="${escapeHtml(c.url)}" target="_blank" rel="noopener">${escapeHtml(c.title)}</a>
            <div class="meta">${tjm}${escapeHtml(c.source)} · ${escapeHtml(String(c.postedAt ?? c.fetchedAt))}</div>
          </div>`;
      })
      .join("");
  };

  document.getElementById("q").addEventListener("input", (e) => render(e.target.value));
  render("");
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (ch) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch],
  );
}

load();
```

> Note: every dynamic value injected via `innerHTML` (title, url, source, date) is passed through `escapeHtml` to prevent XSS from scraped content. `c.tjm` is a number, so its interpolation is safe. If the dashboard grows richer, replace string-building with safe DOM methods (`textContent` / `createElement`) or a sanitizer like DOMPurify.

- [ ] **Step 6: Delete the superseded smoke test**

Run: `git rm test/smoke.test.ts`

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: PASS — all suites green (store, http, reddit, prefilter, fetchTick, api, index).

- [ ] **Step 8: Manually verify the worker locally**

Run (separate terminal): `npm run dev`
Then in another shell:

```bash
# Trigger the scheduled handler against the local cron route
curl "http://localhost:8787/__scheduled?cron=*/30+*+*+*+*"
# Browse results
curl "http://localhost:8787/api/stats"
curl "http://localhost:8787/api/candidates?limit=5"
```

Expected: `/__scheduled` returns 200; `/api/stats` shows `totalRuns` ≥ 1; `/api/candidates` lists any `[Hiring]` React/TS posts currently live on `r/forhire`. Open `http://localhost:8787/` in a browser to see the dashboard. (If `r/forhire` has no matching posts right now, the list may be empty — that is correct behavior, not a bug.)

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat: wire worker entry, dashboard, and end-to-end fetch tick"
```

- [ ] **Step 10: (Optional) Provision remote D1 + deploy**

Only when ready to run in the cloud (requires `npx wrangler login`):

```bash
npx wrangler d1 create missions-free   # copy the returned database_id
# → paste it into wrangler.jsonc d1_databases[0].database_id (replace "local-dev")
npm run migrate:remote                  # apply migrations to remote D1
npm run deploy                          # deploy worker + cron + assets
```

Expected: deploy succeeds; the `*/30` cron begins firing; the dashboard is live at the `*.workers.dev` URL. (Locking the dashboard behind Cloudflare Access is M3.)

---

## Self-Review

**Spec coverage (M1 scope only):**
- §3 single Worker, `scheduled()` + `fetch()` routing → Task 7 ✓
- §3 `fetch` tick (round-robin not needed with 1 source in M1; loops all enabled adapters) → Task 5 ✓
- §3 D1 as store → Tasks 0,1 ✓
- §4 pluggable adapter registry + `SourceAdapter`/`RawMission`/`AdapterCtx` → Tasks 2,3,5 ✓
- §4 shared HTTP helper (UA, backoff, `Retry-After`, conditional ETag) → Task 2 ✓
- §4 Phase-1 first source (Reddit) → Task 3 ✓
- §5 deterministic pre-filter (include/exclude/TJM/lowball) → Task 4 ✓ (language guess intentionally deferred — noted YAGNI in spec §5; not an M1 requirement)
- §6 dashboard + JSON API (`/api/candidates` substitutes for `/api/missions` until M2 adds scored missions) → Tasks 6,7 ✓
- §6 data model `candidates`, `source_state`, `runs` → Task 0 migration ✓ (`missions` deferred to M2 per §10)
- §8 platform safety: sanctioned source, UA, backoff, conditional requests, low frequency (cron `*/30`) → Tasks 2,3 ✓
- Out of scope confirmed absent: no Workers AI, no `missions` table, no email, no LinkedIn, no Access ✓

**Placeholder scan:** No TBD/TODO; every code step contains complete, runnable code; every command lists expected output. ✓

**Type consistency:** `RawMission`, `SourceAdapter`, `AdapterCtx`, `FetchResult`, `SourceState` defined once in `src/sources/types.ts` and imported everywhere. `CandidateInput` (store) extends `RawMission` and is the type `runFetchTick` builds and `insertCandidates` consumes — consistent across Tasks 1 and 5. `PrefilterProfile` (prefilter) and `Profile` (config) both expose `skills`/`hardKill`/`tjm.lowballBelow`; `config.profile` is assignable to `PrefilterProfile` (structural match) — verified in Task 5 default usage. `handleApi` returns `Response | null` and `index.ts` treats null as fall-through — consistent across Tasks 6,7. `Env` (`DB`, `ASSETS`) defined once in `src/types/env.ts`. ✓

**Note on `D1Result.meta.changes`:** `insertCandidates` sums `meta.changes`. `INSERT OR IGNORE` reports `changes: 0` for ignored duplicate rows in D1/SQLite, which is what the dedupe test in Task 1 asserts. If a future runtime omits `changes`, the `?? 0` guard prevents NaN.
