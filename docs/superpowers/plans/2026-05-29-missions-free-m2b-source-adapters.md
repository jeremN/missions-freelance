# missions-free — M2b (Source Adapters) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two source adapters (Free-Work and WTTJ) alongside the existing Reddit adapter, with a small `fetchText` extension to the HTTP helper and a dependency-free RSS/Atom parser. No schema changes, no new runtime dependencies.

**Architecture:** Adapters discover their best public endpoint (RSS preferred, JSON if no RSS, HTML scrape as last resort). Adapter-level filtering owns "what makes this source meaningful" (Reddit's `[Hiring]` prefix; WTTJ's `?contract=freelance&location=France`); the central M1 `prefilter` continues to own user-profile rules. `fetchTick` loops adapters sequentially with the existing per-adapter try/catch isolation. The M2a scoring tick is untouched.

**Tech Stack:** TypeScript, Cloudflare Workers (`HTMLRewriter` for XML parsing — built-in, no deps), D1, Vitest + `@cloudflare/vitest-pool-workers`. No new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-05-29-missions-free-m2b-source-adapters-design.md`.
**Predecessors:** M1 (shipped) and M2a (shipped, see `docs/superpowers/plans/2026-05-28-missions-free-m2a-ai-scoring.md`).

---

## File Structure (M2b)

```
src/sources/
  http.ts                # MODIFY: add createFetchClients, fetchText, extract withRetry
  rss.ts                 # NEW: parseRssItems (RSS-2.0 + Atom, HTMLRewriter-based)
  free-work.ts           # NEW: freeWorkAdapter
  wttj.ts                # NEW: wttjAdapter
  registry.ts            # MODIFY: register the two new adapters
  types.ts               # MODIFY: extend AdapterCtx with fetchText
  reddit.ts              # UNCHANGED

src/pipeline/fetchTick.ts # MODIFY: use createFetchClients

test/sources/
  fixtures/
    free-work-sample.rss.xml   # NEW (captured during Task 2 recon)
    wttj-sample.json           # NEW (captured during Task 3 recon)
                               # OR wttj-sample.html if no JSON
  http.test.ts            # MODIFY: + fetchText tests; switch existing tests to createFetchClients
  rss.test.ts             # NEW: parseRssItems tests
  free-work.test.ts       # NEW: freeWorkAdapter tests
  wttj.test.ts            # NEW: wttjAdapter tests

test/pipeline/fetchTick.test.ts  # MODIFY: 3-adapter integration scenario
```

**Execution order:** linear — Task 0 lays the HTTP foundation; Task 1 adds the RSS parser; Tasks 2–3 are the two adapters (each independent of the other given Task 1's parser); Task 4 wires them into the registry, extends the integration test, and updates the README.

**What M2b deliberately omits** (per spec §1): cross-source dedup, LinkedIn (M4), Hellowork / Telegram (M2c), any schema change, any new runtime dependency, source-prioritized scoring (M3+), prefilter tightening, dashboard changes.

---

## Task 0: Foundation — fetchText sibling + createFetchClients factory

**Files:**
- Modify: `src/sources/http.ts`, `src/sources/types.ts`, `src/pipeline/fetchTick.ts`, `test/sources/http.test.ts`

The existing `createFetchJson` becomes `createFetchClients` returning `{ fetchJson, fetchText }`. The retry / Retry-After / exponential-backoff logic is extracted into a private `withRetry` helper used by both clients.

- [ ] **Step 1: Read the existing `src/sources/http.ts` and `test/sources/http.test.ts`**

You need to understand the current shape before refactoring. Open both files. Confirm:
- `createFetchJson` returns `FetchJson` with retry on 429/403/5xx, Retry-After honored, max 3 retries, 20 s cap.
- `http.test.ts` constructs `createFetchJson({ fetchImpl, baseDelayMs, maxRetries })` with a fake `fetch`.

- [ ] **Step 2: Replace `src/sources/http.ts` contents**

```ts
import type { FetchResult } from "./types";

const USER_AGENT =
  "missions-free/0.1 (+https://github.com/; personal freelance-mission radar)";

// Cap any single backoff so a hostile/misconfigured upstream can't stall the
// whole tick — Workers have wall-clock limits and we round-robin many sources.
const MAX_RETRY_DELAY_MS = 20_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface FetchJsonDeps {
  fetchImpl?: typeof fetch;
  baseDelayMs?: number;
  maxRetries?: number;
}

export type FetchJson = <T>(
  url: string,
  opts?: { etag?: string | null; lastModified?: string | null },
) => Promise<FetchResult<T>>;

export type FetchText = (
  url: string,
  opts?: { etag?: string | null; lastModified?: string | null },
) => Promise<FetchResult<string>>;

export interface FetchClients {
  fetchJson: FetchJson;
  fetchText: FetchText;
}

/** Build a conditional, rate-limit-respecting pair of fetchers. */
export function createFetchClients(deps: FetchJsonDeps = {}): FetchClients {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const baseDelayMs = deps.baseDelayMs ?? 800;
  const maxRetries = deps.maxRetries ?? 3;

  async function withRetry(
    url: string,
    accept: string,
    opts: { etag?: string | null; lastModified?: string | null } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = {
      "User-Agent": USER_AGENT,
      Accept: accept,
    };
    if (opts.etag != null) headers["If-None-Match"] = opts.etag;
    if (opts.lastModified != null)
      headers["If-Modified-Since"] = opts.lastModified;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const res = await fetchImpl(url, { headers });

      if (res.status === 304 || res.ok) return res;

      // 403 is treated as retryable because some APIs (e.g. Reddit) return it
      // transiently under throttling, not just for true authorization failures.
      const retryable =
        res.status === 429 || res.status === 403 || res.status >= 500;
      if (!retryable || attempt === maxRetries) {
        throw new Error(`fetch ${url} failed: HTTP ${res.status}`);
      }

      // Retry-After is in seconds; fall back to exponential backoff otherwise.
      const retryAfter = Number(res.headers.get("retry-after"));
      const rawDelay = Number.isFinite(retryAfter)
        ? retryAfter * 1000
        : baseDelayMs * 2 ** attempt;
      await sleep(Math.min(Math.max(0, rawDelay), MAX_RETRY_DELAY_MS));
    }
    // Unreachable, but satisfies the type checker.
    throw new Error(`fetch ${url} failed: retries exhausted`);
  }

  const fetchJson: FetchJson = async <T>(url, opts = {}) => {
    const res = await withRetry(url, "application/json", opts);
    if (res.status === 304) return { data: null, notModified: true };
    const data = (await res.json()) as T;
    return {
      data,
      etag: res.headers.get("etag") ?? undefined,
      lastModified: res.headers.get("last-modified") ?? undefined,
      notModified: false,
    };
  };

  const fetchText: FetchText = async (url, opts = {}) => {
    const res = await withRetry(
      url,
      "text/xml, application/xml, application/atom+xml, application/rss+xml, text/html, */*",
      opts,
    );
    if (res.status === 304) return { data: null, notModified: true };
    const data = await res.text();
    return {
      data,
      etag: res.headers.get("etag") ?? undefined,
      lastModified: res.headers.get("last-modified") ?? undefined,
      notModified: false,
    };
  };

  return { fetchJson, fetchText };
}
```

- [ ] **Step 3: Extend `src/sources/types.ts`**

Open the file and update the `AdapterCtx` interface so adapters can receive both fetchers. The `FetchText` import is added.

```ts
import type { FetchJson, FetchText } from "./http";

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
  fetchJson: FetchJson;
  fetchText: FetchText;
}

/**
 * What an adapter's `fetch()` returns. The optional `state` lets the adapter
 * surface fresh cache validators (etag / lastModified / cursor) so the pipeline
 * can persist them — required for conditional requests to actually work across
 * ticks. Adapters that don't need this can omit `state`; the pipeline then
 * preserves whatever was already stored.
 */
export interface AdapterRun {
  missions: RawMission[];
  state?: Partial<Pick<SourceState, "etag" | "lastModified" | "cursor">>;
}

export interface SourceAdapter {
  id: string;
  enabled: boolean;
  fetch(ctx: AdapterCtx): Promise<AdapterRun>;
}
```

The existing `redditAdapter` does not use `fetchText` — structural typing means it keeps compiling unchanged.

- [ ] **Step 4: Update `src/pipeline/fetchTick.ts`**

Two-line change: import `createFetchClients` instead of `createFetchJson`, and destructure both fetchers into `AdapterCtx`.

Replace:
```ts
import { createFetchJson } from "../sources/http";
```
with:
```ts
import { createFetchClients } from "../sources/http";
```

Replace:
```ts
const fetchJson = createFetchJson();
```
with:
```ts
const { fetchJson, fetchText } = createFetchClients();
```

Replace:
```ts
const run = await adapter.fetch({ state: prior, fetchJson });
```
with:
```ts
const run = await adapter.fetch({ state: prior, fetchJson, fetchText });
```

- [ ] **Step 5: Update `test/sources/http.test.ts` to use `createFetchClients`**

Open the file. Every line that reads `createFetchJson(deps)` becomes `createFetchClients(deps).fetchJson`. Also add new tests for `fetchText`.

At the top of the file, replace the existing import:

```ts
import { createFetchClients } from "../../src/sources/http";
```

Inside each existing test that uses `createFetchJson(...)`, replace with:

```ts
const { fetchJson } = createFetchClients({ fetchImpl, baseDelayMs: 1, maxRetries: 2 });
```

(Keep the same `baseDelayMs` and `maxRetries` the existing tests use — they're already short.)

Then APPEND the following new `describe` block at the end of the file (above the closing of the outermost `describe`, or as a new top-level `describe` — match the file's existing structure):

```ts
describe("fetchText", () => {
  it("returns body text and headers on 200", async () => {
    const fetchImpl: typeof fetch = (async () =>
      new Response("<rss><channel><item><title>hi</title></item></channel></rss>", {
        status: 200,
        headers: {
          etag: "W/\"abc\"",
          "last-modified": "Wed, 28 May 2026 12:00:00 GMT",
        },
      })) as unknown as typeof fetch;
    const { fetchText } = createFetchClients({ fetchImpl, baseDelayMs: 1, maxRetries: 2 });
    const res = await fetchText("https://example.test/feed.rss");
    expect(res.notModified).toBe(false);
    expect(res.data).toContain("<title>hi</title>");
    expect(res.etag).toBe("W/\"abc\"");
    expect(res.lastModified).toBe("Wed, 28 May 2026 12:00:00 GMT");
  });

  it("returns notModified on 304", async () => {
    const fetchImpl: typeof fetch = (async () =>
      new Response(null, { status: 304 })) as unknown as typeof fetch;
    const { fetchText } = createFetchClients({ fetchImpl, baseDelayMs: 1, maxRetries: 2 });
    const res = await fetchText("https://example.test/feed.rss", { etag: "W/\"abc\"" });
    expect(res.notModified).toBe(true);
    expect(res.data).toBeNull();
  });

  it("retries on 429 then succeeds", async () => {
    let n = 0;
    const fetchImpl: typeof fetch = (async () => {
      n += 1;
      if (n === 1) {
        return new Response("rate limited", { status: 429, headers: { "retry-after": "0" } });
      }
      return new Response("<rss></rss>", { status: 200 });
    }) as unknown as typeof fetch;
    const { fetchText } = createFetchClients({ fetchImpl, baseDelayMs: 1, maxRetries: 3 });
    const res = await fetchText("https://example.test/feed.rss");
    expect(res.notModified).toBe(false);
    expect(res.data).toBe("<rss></rss>");
    expect(n).toBe(2);
  });

  it("throws on a persistent 500 after max retries", async () => {
    const fetchImpl: typeof fetch = (async () =>
      new Response("server error", { status: 500 })) as unknown as typeof fetch;
    const { fetchText } = createFetchClients({ fetchImpl, baseDelayMs: 1, maxRetries: 2 });
    await expect(fetchText("https://example.test/feed.rss")).rejects.toThrow(/HTTP 500/);
  });
});
```

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: `Tests 75 passed (75)` (71 prior + 4 new `fetchText` tests). All 71 existing tests still green.

If the count differs by ±1 because the existing `http.test.ts` had a `describe` re-counting quirk, that's fine as long as everything is green and the 4 new `fetchText` tests are visible in the per-file breakdown.

- [ ] **Step 7: Commit**

```bash
git add src/sources/http.ts src/sources/types.ts src/pipeline/fetchTick.ts test/sources/http.test.ts
git commit -m "feat: add fetchText sibling to fetchJson via createFetchClients factory"
```

---

## Task 1: RSS-2.0 / Atom parser

**Files:**
- Create: `src/sources/rss.ts`
- Test: `test/sources/rss.test.ts`

A focused, dependency-free parser using Cloudflare's `HTMLRewriter`. Handles both RSS-2.0 (`<rss><channel><item>`) and Atom (`<feed><entry>`). Returns `[]` on malformed or empty XML — never throws.

- [ ] **Step 1: Write the failing test**

Create `test/sources/rss.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseRssItems } from "../../src/sources/rss";

const RSS_2 = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Sample feed</title>
    <item>
      <guid isPermaLink="false">post-1</guid>
      <title>Senior React freelance, 6 mois</title>
      <link>https://example.test/post/1</link>
      <description><![CDATA[6 mois, full remote, 600€/j.]]></description>
      <pubDate>Wed, 28 May 2026 12:00:00 GMT</pubDate>
    </item>
    <item>
      <guid isPermaLink="true">https://example.test/post/2</guid>
      <title>TypeScript backend freelance</title>
      <link>https://example.test/post/2</link>
      <description>Node + TS, 3 mois renouvelable.</description>
    </item>
  </channel>
</rss>`;

const ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Sample feed</title>
  <entry>
    <id>tag:example.test,2026:1</id>
    <title>Vue freelance, full remote</title>
    <link href="https://example.test/atom/1" />
    <summary>Vue 3 + TS, 4 mois.</summary>
    <updated>2026-05-28T12:00:00Z</updated>
  </entry>
</feed>`;

describe("parseRssItems", () => {
  it("parses RSS-2.0 items with guid, title, link, description, pubDate", async () => {
    const items = await parseRssItems(RSS_2);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      id: "post-1",
      title: "Senior React freelance, 6 mois",
      link: "https://example.test/post/1",
      description: "6 mois, full remote, 600€/j.",
      pubDate: "Wed, 28 May 2026 12:00:00 GMT",
    });
    expect(items[1].id).toBe("https://example.test/post/2");
    expect(items[1].title).toBe("TypeScript backend freelance");
    expect(items[1].link).toBe("https://example.test/post/2");
    expect(items[1].description).toContain("Node + TS");
    expect(items[1].pubDate).toBeUndefined();
  });

  it("parses Atom entries with id, title, link href, summary, updated", async () => {
    const items = await parseRssItems(ATOM);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: "tag:example.test,2026:1",
      title: "Vue freelance, full remote",
      link: "https://example.test/atom/1",
      description: "Vue 3 + TS, 4 mois.",
      pubDate: "2026-05-28T12:00:00Z",
    });
  });

  it("returns [] on malformed XML rather than throwing", async () => {
    expect(await parseRssItems("<not really xml")).toEqual([]);
    expect(await parseRssItems("")).toEqual([]);
    expect(await parseRssItems("plain text body")).toEqual([]);
  });

  it("drops items missing title or both id and link, keeps siblings", async () => {
    const partial = `<?xml version="1.0"?>
      <rss><channel>
        <item><title>kept</title><link>https://x/1</link></item>
        <item><link>https://x/2</link></item> <!-- no title, dropped -->
        <item><title>also kept</title><guid>g3</guid></item>
      </channel></rss>`;
    const items = await parseRssItems(partial);
    expect(items.map((i) => i.title)).toEqual(["kept", "also kept"]);
    expect(items[0].id).toBe("https://x/1"); // falls back to link
    expect(items[1].id).toBe("g3");
  });

  it("decodes common HTML entities in text fields", async () => {
    const xml = `<?xml version="1.0"?>
      <rss><channel><item>
        <title>R&amp;D freelance &lt;senior&gt;</title>
        <link>https://x/1</link>
        <description>Need &quot;remote&quot; profile</description>
      </item></channel></rss>`;
    const items = await parseRssItems(xml);
    expect(items[0].title).toBe("R&D freelance <senior>");
    expect(items[0].description).toBe('Need "remote" profile');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/sources/rss.test.ts`
Expected: FAIL — `Cannot find module '../../src/sources/rss'`.

- [ ] **Step 3: Write `src/sources/rss.ts`**

```ts
export interface RssItem {
  id: string;            // <guid>, Atom <id>, else <link>
  title: string;
  link: string;
  description: string;
  pubDate?: string;
}

interface PartialItem {
  id?: string;
  title?: string;
  link?: string;
  description?: string;
  pubDate?: string;
}

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
  "&#39;": "'",
};

function decodeEntities(s: string): string {
  return s.replace(/&(?:amp|lt|gt|quot|apos|#39);/g, (m) => ENTITIES[m] ?? m);
}

/**
 * Parse RSS-2.0 / Atom `<item>` / `<entry>` elements out of an XML string.
 * Returns [] on malformed XML rather than throwing — adapters treat that as
 * "no new missions this tick".
 *
 * Only the fields the adapters need are extracted. CDATA sections survive via
 * HTMLRewriter's text handler. Items missing both id/guid AND link, or
 * missing title, are dropped silently.
 */
export async function parseRssItems(xml: string): Promise<RssItem[]> {
  if (!xml || typeof xml !== "string") return [];

  const items: PartialItem[] = [];
  let current: PartialItem | null = null;
  let textTarget: keyof PartialItem | null = null;
  let textBuffer = "";

  const rewriter = new HTMLRewriter()
    .on("item, entry", {
      element(el) {
        current = {};
        el.onEndTag(() => {
          if (current) items.push(current);
          current = null;
        });
      },
    })
    .on(
      "item > guid, entry > id, item > title, entry > title, item > description, entry > summary, entry > content, item > pubDate, entry > updated",
      {
        element(el) {
          if (!current) return;
          const tag = el.tagName.toLowerCase();
          textBuffer = "";
          textTarget =
            tag === "guid" || tag === "id"
              ? "id"
              : tag === "title"
              ? "title"
              : tag === "description" || tag === "summary" || tag === "content"
              ? "description"
              : tag === "pubdate" || tag === "updated"
              ? "pubDate"
              : null;
          el.onEndTag(() => {
            if (current && textTarget) {
              current[textTarget] = decodeEntities(textBuffer.trim());
            }
            textTarget = null;
            textBuffer = "";
          });
        },
        text(t) {
          if (textTarget) textBuffer += t.text;
        },
      },
    )
    .on("item > link, entry > link", {
      element(el) {
        if (!current) return;
        // Atom: <link href="..."/>; RSS: <link>...</link>
        const href = el.getAttribute("href");
        if (href) {
          current.link = href;
          return;
        }
        textBuffer = "";
        textTarget = "link";
        el.onEndTag(() => {
          if (current && textTarget === "link") {
            current.link = decodeEntities(textBuffer.trim());
          }
          textTarget = null;
          textBuffer = "";
        });
      },
      text(t) {
        if (textTarget === "link") textBuffer += t.text;
      },
    });

  try {
    // HTMLRewriter expects a Response stream; wrap the xml string.
    await rewriter.transform(new Response(xml)).text();
  } catch {
    return [];
  }

  const out: RssItem[] = [];
  for (const p of items) {
    if (!p.title) continue;
    const id = p.id ?? p.link;
    const link = p.link ?? p.id;
    if (!id || !link) continue;
    out.push({
      id,
      title: p.title,
      link,
      description: p.description ?? "",
      pubDate: p.pubDate,
    });
  }
  return out;
}
```

> Note: `HTMLRewriter` is available globally inside Workers. The `Response` wrapper feeds the string as a body stream. The `try/catch` around `.transform(...).text()` is the safety net for any HTMLRewriter quirk on malformed XML (it should return whatever it parsed up to the failure; if it ever throws, we return `[]`).

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/sources/rss.test.ts`
Expected: PASS (5 tests).

If a test fails because `HTMLRewriter` interprets a particular fixture differently than expected (e.g., the entity-decoding test or the Atom `<link href>`), open the failure, inspect what the parser actually returned, and adjust the test fixture's expectations — NOT the validator's defensive checks. The shape contract (every published `RssItem` has a non-empty `title` and `link`) is non-negotiable.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: `Tests 80 passed (80)` (75 + 5 new).

- [ ] **Step 6: Commit**

```bash
git add src/sources/rss.ts test/sources/rss.test.ts
git commit -m "feat: add RSS-2.0 and Atom feed parser via HTMLRewriter"
```

---

## Task 2: free-work source adapter

**Files:**
- Create: `src/sources/free-work.ts`, `test/sources/free-work.test.ts`, `test/sources/fixtures/free-work-sample.rss.xml`

This task has a **recon step** because the exact Free-Work endpoint isn't pinned in the spec. The plan picks a starting URL; if recon reveals it's not RSS or the shape is different, the adapter pivots (see "JSON fallback" at the end of the task).

- [ ] **Step 1: Recon — discover Free-Work's freelance listing endpoint**

Run, from the repo root:

```bash
# Candidate URLs, in priority order. Try each until one returns 200 with feed-shaped content.
curl -sI "https://www.free-work.com/fr/tech-it/jobs/feed?contract=contractor"
curl -sI "https://www.free-work.com/fr/tech-it/jobs.rss?contract=contractor"
curl -sI "https://www.free-work.com/fr/tech-it/jobs.atom?contract=contractor"
curl -sI "https://www.free-work.com/api/v1/jobs?contract=contractor&country=FR"
```

Pick the first one that returns `200 OK` with `Content-Type` containing `xml` / `atom` / `rss` (preferred), OR `application/json` (fallback).

Open the chosen URL in a browser or `curl -s | head -100` to verify it actually returns freelance mission listings (not CDI / not stale / not blocked).

If NONE of the above works:
- Open https://www.free-work.com/ in a browser, find the freelance listings page, capture the network request the page makes (DevTools → Network), and use that endpoint.
- If the only available shape is HTML, halt and report status `BLOCKED` to the controller — HTML scraping for Free-Work is out of scope for M2b per the approved approach.

- [ ] **Step 2: Capture the fixture**

With the chosen URL stored in your shell:

```bash
mkdir -p test/sources/fixtures
curl -s -A "missions-free/0.1 (+https://github.com/; personal freelance-mission radar)" \
  "<CHOSEN_URL>" > test/sources/fixtures/free-work-sample.rss.xml
wc -l test/sources/fixtures/free-work-sample.rss.xml
head -5 test/sources/fixtures/free-work-sample.rss.xml
```

Verify the file is at least 500 bytes and starts with `<?xml` (RSS/Atom) or `{` (JSON). Commit nothing yet — the fixture commits with the adapter.

If the response includes any personal data (a logged-in user header, an account email in the feed), open the file and redact before proceeding.

- [ ] **Step 3: Write the failing test**

Create `test/sources/free-work.test.ts`. **Two test paths are sketched** — pick the one that matches what recon found. (Most likely the RSS path.)

**Path A: RSS / Atom fixture (most likely)**

```ts
import { describe, expect, it, vi } from "vitest";
import { freeWorkAdapter } from "../../src/sources/free-work";
import type { AdapterCtx, FetchResult } from "../../src/sources/types";
import freeWorkFixture from "./fixtures/free-work-sample.rss.xml?raw";

function ctxWith(text: FetchResult<string>): AdapterCtx {
  return {
    state: null,
    fetchJson: vi.fn() as never,
    fetchText: vi.fn(async () => text) as never,
  };
}

describe("freeWorkAdapter", () => {
  it("maps captured RSS items into RawMission[]", async () => {
    const run = await freeWorkAdapter.fetch(
      ctxWith({
        data: freeWorkFixture,
        etag: "W/\"new-etag\"",
        lastModified: "Fri, 29 May 2026 09:00:00 GMT",
        notModified: false,
      }),
    );
    expect(run.missions.length).toBeGreaterThan(0);
    for (const m of run.missions) {
      expect(m.source).toBe("free-work");
      expect(typeof m.externalId).toBe("string");
      expect(m.externalId.length).toBeGreaterThan(0);
      expect(m.url).toMatch(/^https?:\/\//);
      expect(typeof m.title).toBe("string");
      expect(m.title.length).toBeGreaterThan(0);
    }
    expect(run.state?.etag).toBe("W/\"new-etag\"");
    expect(run.state?.lastModified).toBe("Fri, 29 May 2026 09:00:00 GMT");
  });

  it("returns no missions on 304 Not Modified", async () => {
    const run = await freeWorkAdapter.fetch(
      ctxWith({ data: null, notModified: true }),
    );
    expect(run.missions).toEqual([]);
    expect(run.state).toBeUndefined();
  });

  it("returns no missions when the feed body is malformed XML", async () => {
    const run = await freeWorkAdapter.fetch(
      ctxWith({
        data: "<not really xml",
        etag: undefined,
        lastModified: undefined,
        notModified: false,
      }),
    );
    expect(run.missions).toEqual([]);
  });

  it("passes the configured URL with the user's etag to fetchText", async () => {
    const fetchText = vi.fn(async () => ({
      data: freeWorkFixture,
      notModified: false,
    })) as never as AdapterCtx["fetchText"];
    const run = await freeWorkAdapter.fetch({
      state: { source: "free-work", etag: "W/\"prior\"", lastModified: null, cursor: null, lastRunAt: null },
      fetchJson: vi.fn() as never,
      fetchText,
    });
    expect(fetchText).toHaveBeenCalledTimes(1);
    const [calledUrl, calledOpts] = (fetchText as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(typeof calledUrl).toBe("string");
    expect(calledUrl).toMatch(/^https:\/\/[^/]*free-work\./);
    expect(calledOpts.etag).toBe("W/\"prior\"");
    expect(run.missions.length).toBeGreaterThan(0);
  });
});
```

**Path B: JSON fixture (if recon found a JSON endpoint instead of RSS)** — see "JSON variant" at the end of this task.

- [ ] **Step 4: Run test to verify it fails**

Run: `npm test -- test/sources/free-work.test.ts`
Expected: FAIL — `Cannot find module '../../src/sources/free-work'`.

(The `?raw` import suffix is supported by vitest-pool-workers when the file exists; if the fixture file is missing, the failure says "Cannot find module './fixtures/free-work-sample.rss.xml?raw'" — capture the fixture per Step 2 if you skipped it.)

- [ ] **Step 5: Write `src/sources/free-work.ts`** (RSS variant)

```ts
import type { AdapterCtx, AdapterRun, SourceAdapter } from "./types";
import { parseRssItems } from "./rss";

// Pinned during M2b Task 2 recon. URL is freelance-only by construction
// (free-work.com is a freelance board); no extra adapter-level filter needed.
const FEED_URL = "<PIN_THIS_TO_THE_CHOSEN_URL_FROM_STEP_1>";

export const freeWorkAdapter: SourceAdapter = {
  id: "free-work",
  enabled: true,

  async fetch(ctx: AdapterCtx): Promise<AdapterRun> {
    const res = await ctx.fetchText(FEED_URL, {
      etag: ctx.state?.etag,
      lastModified: ctx.state?.lastModified,
    });
    if (res.notModified || !res.data) {
      // Nothing changed upstream — don't overwrite the stored validators.
      return { missions: [] };
    }

    const items = await parseRssItems(res.data);
    const missions = items.map((it) => ({
      source: "free-work",
      externalId: it.id,
      url: it.link,
      title: it.title,
      body: it.description,
      postedAt: it.pubDate,
    }));

    return {
      missions,
      state: { etag: res.etag, lastModified: res.lastModified },
    };
  },
};
```

Replace `<PIN_THIS_TO_THE_CHOSEN_URL_FROM_STEP_1>` with the URL you found in Step 1.

- [ ] **Step 6: Run test to verify it passes**

Run: `npm test -- test/sources/free-work.test.ts`
Expected: PASS (4 tests).

If the fixture has zero parseable items (e.g., the captured response is empty or weirdly shaped), the first test's `expect(run.missions.length).toBeGreaterThan(0)` fails. Either:
- The fixture is bad — re-capture from a different time of day.
- The fixture is JSON — switch to Path B (JSON variant below).
- The fixture is HTML — halt and escalate per "If NONE of the above works" in Step 1.

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: `Tests 84 passed (84)` (80 + 4 new). All earlier tests still green.

- [ ] **Step 8: Commit**

```bash
git add src/sources/free-work.ts test/sources/free-work.test.ts test/sources/fixtures/free-work-sample.rss.xml
git commit -m "feat: add free-work source adapter"
```

---

### JSON variant (Path B) — only if Step 1 found JSON not RSS

If `<CHOSEN_URL>` returned JSON, replace the fixture filename with `.json`:

```bash
mv test/sources/fixtures/free-work-sample.rss.xml test/sources/fixtures/free-work-sample.json
```

In `test/sources/free-work.test.ts`, change the fixture import:

```ts
import freeWorkFixture from "./fixtures/free-work-sample.json";
```

(No `?raw` — vitest auto-parses JSON imports.)

In `src/sources/free-work.ts`, replace `ctx.fetchText` with `ctx.fetchJson<FreeWorkResponse>` and write a mapper from the actual JSON shape to `RawMission`. Type `FreeWorkResponse` according to what you observed; mirror the loose-validation pattern from `redditAdapter` (per-item validator that drops malformed entries silently).

The four test cases above translate trivially:
- "maps captured items into RawMission[]" — fixture is the parsed object instead of a string.
- "returns no missions on 304" — `ctx.fetchJson` returns `{ data: null, notModified: true }`.
- "returns no missions when the body is malformed" — `ctx.fetchJson` returns `{ data: { unexpected: "shape" } }` — your mapper rejects it.
- "passes etag through" — same.

---

## Task 3: wttj source adapter

**Files:**
- Create: `src/sources/wttj.ts`, `test/sources/wttj.test.ts`, `test/sources/fixtures/wttj-sample.json` (or `.rss.xml` if recon finds RSS)

Same flow as Task 2.

- [ ] **Step 1: Recon — discover WTTJ's freelance-only listing endpoint**

Run, from the repo root:

```bash
# Candidate URLs. The WTTJ search UI usually backs onto a JSON endpoint; the
# public search-results URLs are JS-rendered, so the JSON API is what we want.
curl -sI "https://www.welcometothejungle.com/api/v1/jobs?contract_type=freelance&country=FR"
curl -sI "https://api.welcometothejungle.com/api/v1/jobs?contract_type=freelance&country=FR"
curl -sI "https://www.welcometothejungle.com/fr/jobs/feed?contract=freelance&country=FR"
curl -sI "https://www.welcometothejungle.com/fr/jobs.rss?contract=freelance&country=FR"
```

Pick the first one that returns `200 OK` with a useful content type. If WTTJ requires `Authorization` (an API key), HALT and escalate: WTTJ-with-auth is out of scope for M2b — the milestone would drop to a single-adapter M2b (just Free-Work) and WTTJ becomes M2c with the auth question to resolve.

If you find the actual endpoint by inspecting the WTTJ search page's network requests (DevTools), that's also acceptable; document the URL in Step 5.

- [ ] **Step 2: Capture the fixture**

```bash
curl -s -A "missions-free/0.1 (+https://github.com/; personal freelance-mission radar)" \
  "<CHOSEN_URL>" > test/sources/fixtures/wttj-sample.json
wc -c test/sources/fixtures/wttj-sample.json
head -200 test/sources/fixtures/wttj-sample.json
```

Verify the file is meaningfully non-empty and structurally JSON (or XML if recon found RSS). Redact any personal data.

- [ ] **Step 3: Inspect the JSON shape to derive a typed response interface**

Open `test/sources/fixtures/wttj-sample.json` and identify:
- The array of jobs (likely `data`, `jobs`, `hits`, `results`, etc. — depends on the API).
- The per-job fields you need: a stable id, a public URL, a title, a description, a posted date, and a contract type (to double-check freelance filtering).

Sketch the response interface in `src/sources/wttj.ts` (next step) accordingly. A common shape:

```ts
interface WttjJob {
  id?: string | number;
  reference?: string;
  url?: string;
  slug?: string;
  name?: string;
  title?: string;
  description?: string;
  published_at?: string;
  contract_type?: { name?: string };
  office?: { country?: { code?: string } };
}
interface WttjResponse {
  hits?: { jobs?: { results?: WttjJob[] } };
  // or: results?: WttjJob[]
  // or: data?: WttjJob[]
}
```

Pick whichever path actually appears in the fixture. Document the exact path you used in a comment at the top of the adapter.

- [ ] **Step 4: Write the failing test**

Create `test/sources/wttj.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { wttjAdapter } from "../../src/sources/wttj";
import type { AdapterCtx, FetchResult } from "../../src/sources/types";
import wttjFixture from "./fixtures/wttj-sample.json";

function ctxWith<T>(res: FetchResult<T>): AdapterCtx {
  return {
    state: null,
    fetchJson: vi.fn(async () => res) as never,
    fetchText: vi.fn() as never,
  };
}

describe("wttjAdapter", () => {
  it("maps captured jobs into RawMission[] with source='wttj'", async () => {
    const run = await wttjAdapter.fetch(
      ctxWith({
        data: wttjFixture,
        etag: "W/\"new-etag\"",
        lastModified: "Fri, 29 May 2026 09:00:00 GMT",
        notModified: false,
      }),
    );
    expect(run.missions.length).toBeGreaterThan(0);
    for (const m of run.missions) {
      expect(m.source).toBe("wttj");
      expect(typeof m.externalId).toBe("string");
      expect(m.externalId.length).toBeGreaterThan(0);
      expect(m.url).toMatch(/^https?:\/\//);
      expect(m.title.length).toBeGreaterThan(0);
    }
    expect(run.state?.etag).toBe("W/\"new-etag\"");
  });

  it("returns no missions on 304 Not Modified", async () => {
    const run = await wttjAdapter.fetch(
      ctxWith({ data: null, notModified: true }),
    );
    expect(run.missions).toEqual([]);
    expect(run.state).toBeUndefined();
  });

  it("returns no missions when the response is malformed (unexpected shape)", async () => {
    const run = await wttjAdapter.fetch(
      ctxWith({
        data: { something: "else" } as never,
        notModified: false,
      }),
    );
    expect(run.missions).toEqual([]);
  });

  it("passes the configured URL with prior etag to fetchJson", async () => {
    const fetchJson = vi.fn(async () => ({
      data: wttjFixture,
      notModified: false,
    })) as never as AdapterCtx["fetchJson"];
    await wttjAdapter.fetch({
      state: { source: "wttj", etag: "W/\"prior\"", lastModified: null, cursor: null, lastRunAt: null },
      fetchJson,
      fetchText: vi.fn() as never,
    });
    expect(fetchJson).toHaveBeenCalledTimes(1);
    const [calledUrl, calledOpts] = (fetchJson as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(typeof calledUrl).toBe("string");
    expect(calledUrl).toMatch(/welcometothejungle/);
    expect(calledUrl).toMatch(/freelance/);
    expect(calledOpts.etag).toBe("W/\"prior\"");
  });
});
```

- [ ] **Step 5: Run test to verify it fails**

Run: `npm test -- test/sources/wttj.test.ts`
Expected: FAIL — `Cannot find module '../../src/sources/wttj'`.

- [ ] **Step 6: Write `src/sources/wttj.ts`**

Adjust the response shape based on what you observed in Step 3. Below is a template using the most common WTTJ shape (`hits.jobs.results`); replace the path if yours differs.

```ts
import type { AdapterCtx, AdapterRun, SourceAdapter, RawMission } from "./types";

// Pinned during M2b Task 3 recon. The URL must include the freelance filter
// and a France geo filter — the adapter does NOT post-filter (the URL is
// supposed to do all the source-shape filtering per the M2b spec §3.1).
const SEARCH_URL =
  "<PIN_THIS_TO_THE_CHOSEN_URL_WITH_contract_type=freelance_AND_country=FR>";

// JSON path is captured here as a comment so it's grep-able if the API shape
// changes upstream: response.hits.jobs.results[] (replace if yours differs).
interface WttjJob {
  id?: string | number;
  reference?: string;
  slug?: string;
  url?: string;
  name?: string;
  title?: string;
  description?: string;
  published_at?: string;
  contract_type?: { name?: string };
}
interface WttjResponse {
  hits?: { jobs?: { results?: WttjJob[] } };
}

function validJob(j: unknown): j is WttjJob {
  if (typeof j !== "object" || j === null) return false;
  const o = j as Record<string, unknown>;
  const hasId =
    typeof o.id === "string" ||
    typeof o.id === "number" ||
    typeof o.reference === "string" ||
    typeof o.slug === "string";
  const hasTitle =
    typeof o.name === "string" || typeof o.title === "string";
  return hasId && hasTitle;
}

function toMission(j: WttjJob): RawMission | null {
  const id = String(j.id ?? j.reference ?? j.slug ?? "");
  const title = j.name ?? j.title ?? "";
  if (!id || !title) return null;
  // Prefer explicit url; otherwise build canonical URL from slug.
  const url =
    j.url ??
    (j.slug
      ? `https://www.welcometothejungle.com/fr/jobs/${j.slug}`
      : undefined);
  if (!url) return null;
  return {
    source: "wttj",
    externalId: id,
    url,
    title,
    body: j.description ?? "",
    postedAt: j.published_at,
  };
}

export const wttjAdapter: SourceAdapter = {
  id: "wttj",
  enabled: true,

  async fetch(ctx: AdapterCtx): Promise<AdapterRun> {
    const res = await ctx.fetchJson<WttjResponse>(SEARCH_URL, {
      etag: ctx.state?.etag,
      lastModified: ctx.state?.lastModified,
    });
    if (res.notModified || !res.data) {
      return { missions: [] };
    }

    const jobs = res.data.hits?.jobs?.results ?? [];
    if (!Array.isArray(jobs)) return { missions: [] };

    const missions: RawMission[] = [];
    for (const j of jobs) {
      if (!validJob(j)) continue;
      const m = toMission(j);
      if (m) missions.push(m);
    }
    return {
      missions,
      state: { etag: res.etag, lastModified: res.lastModified },
    };
  },
};
```

Replace `<PIN_THIS_TO_THE_CHOSEN_URL...>` with the URL you found. Replace the response interface path if yours differs.

- [ ] **Step 7: Run test to verify it passes**

Run: `npm test -- test/sources/wttj.test.ts`
Expected: PASS (4 tests).

If "maps captured jobs into RawMission[]" fails because zero items pass `validJob`, the response shape you typed doesn't match the fixture. Open the fixture and the adapter side by side; trace one job from the JSON to the mapped `RawMission`. Adjust the response interface and `toMission` mapping.

- [ ] **Step 8: Run the full suite**

Run: `npm test`
Expected: `Tests 88 passed (88)` (84 + 4 new).

- [ ] **Step 9: Commit**

```bash
git add src/sources/wttj.ts test/sources/wttj.test.ts test/sources/fixtures/wttj-sample.json
git commit -m "feat: add wttj source adapter"
```

---

### RSS variant (Path B for WTTJ) — only if Step 1 found RSS not JSON

If WTTJ exposes an RSS feed instead of JSON:

- Save the fixture as `test/sources/fixtures/wttj-sample.rss.xml`.
- Change the test import to `import wttjFixture from "./fixtures/wttj-sample.rss.xml?raw";` and the `ctxWith` call to feed the string via `fetchText`.
- In the adapter, swap `ctx.fetchJson<WttjResponse>` for `ctx.fetchText` and feed the result into `parseRssItems` exactly as `freeWorkAdapter` does. The four test cases translate trivially.

---

## Task 4: Registry, integration test, README, smoke

**Files:**
- Modify: `src/sources/registry.ts`, `test/pipeline/fetchTick.test.ts`, `README.md`

- [ ] **Step 1: Register the two new adapters**

Replace the contents of `src/sources/registry.ts`:

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

export function enabledAdapters(): SourceAdapter[] {
  return adapters.filter((a) => a.enabled);
}
```

- [ ] **Step 2: Run the existing fetchTick suite to confirm nothing broke**

Run: `npm test -- test/pipeline/fetchTick.test.ts`
Expected: all existing fetchTick tests still pass. The registry change is invisible because the existing tests inject their own `opts.adapters` arrays — they don't use `enabledAdapters()`.

- [ ] **Step 3: Add a 3-adapter integration test to `test/pipeline/fetchTick.test.ts`**

Read the existing file to find where the adapter-isolation tests live. Below the last existing `it(...)` in the main `describe`, append:

```ts
  it("runs all enabled adapters in sequence and isolates a failing one", async () => {
    const adapterA: SourceAdapter = {
      id: "a",
      enabled: true,
      fetch: vi.fn(async () => ({
        missions: [
          {
            source: "a",
            externalId: "a-1",
            url: "https://a.test/1",
            title: "[Hiring] React",
            body: "TS, full remote, 600€/j.",
          },
        ],
      })) as never,
    };
    const adapterB: SourceAdapter = {
      id: "b",
      enabled: true,
      fetch: vi.fn(async () => {
        throw new Error("transient");
      }) as never,
    };
    const adapterC: SourceAdapter = {
      id: "c",
      enabled: true,
      fetch: vi.fn(async () => ({
        missions: [
          {
            source: "c",
            externalId: "c-1",
            url: "https://c.test/1",
            title: "[Hiring] TypeScript",
            body: "TS, 6 mois, 650€/j.",
          },
        ],
      })) as never,
    };

    const result = await runFetchTick(env, {
      adapters: [adapterA, adapterB, adapterC],
    });
    expect(result.errors).toBe(1);
    expect(result.fetched).toBe(2); // A + C; B threw before producing
    expect(result.inserted).toBeGreaterThanOrEqual(2);

    // Both A and C produced rows; B is logged but not in candidates.
    const rows = await env.DB.prepare(
      "SELECT source FROM candidates ORDER BY source",
    ).all<{ source: string }>();
    const sources = rows.results.map((r) => r.source);
    expect(sources).toContain("a");
    expect(sources).toContain("c");
    expect(sources).not.toContain("b");

    // The run was recorded with adapters=3 even though one threw.
    const run = await env.DB.prepare(
      "SELECT stats FROM runs WHERE tick = 'fetch' ORDER BY id DESC LIMIT 1",
    ).first<{ stats: string }>();
    const stats = JSON.parse(run!.stats);
    expect(stats.adapters).toBe(3);
    expect(stats.errors).toBe(1);
  });
```

If `vi`, `runFetchTick`, `env`, or `SourceAdapter` aren't already imported in the test file's header, add them. The existing tests should already import most of these — only `SourceAdapter` may be new (`import type { SourceAdapter } from "../../src/sources/types";`).

- [ ] **Step 4: Run the integration test**

Run: `npm test -- test/pipeline/fetchTick.test.ts`
Expected: PASS, including the new 3-adapter test.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: `Tests 89 passed (89)` (88 + 1 new).

If the count is off by ±1, that's fine as long as everything is green. The plan's expected per-task counts add up to:

| Task | Δ tests | Cumulative |
|---|---:|---:|
| Pre-M2b baseline | 0 | 71 |
| Task 0 (fetchText) | +4 | 75 |
| Task 1 (rss) | +5 | 80 |
| Task 2 (free-work) | +4 | 84 |
| Task 3 (wttj) | +4 | 88 |
| Task 4 (integration) | +1 | **89** |

- [ ] **Step 6: Update the README's "Tech stack" → "Project structure" section**

Open `README.md`. Find the project structure block (`src/`, with the `sources/` line). Replace the `sources/` line with:

```
  sources/              # Per-source adapters
    reddit.ts           # r/forhire [Hiring] posts (M1)
    free-work.ts        # Free-Work freelance listings (M2b, RSS via parseRssItems)
    wttj.ts             # WTTJ freelance-FR jobs (M2b)
    rss.ts              # RSS-2.0 / Atom parser (M2b)
    http.ts             # createFetchClients → { fetchJson, fetchText }
    registry.ts         # adapters[] consumed by fetchTick
    types.ts            # SourceAdapter, AdapterCtx, RawMission
```

Find the "Status" table at the top. Update the M2b row:

Replace:
```
| M2b | Additional source adapters (FreeWork, Malt feed, LinkedIn). | Planned |
```
with:
```
| **M2b** | Additional source adapters: Free-Work + WTTJ freelance-FR. | ✅ Shipped |
```

- [ ] **Step 7: Commit**

```bash
git add src/sources/registry.ts test/pipeline/fetchTick.test.ts README.md
git commit -m "feat: register free-work and wttj adapters and ship M2b"
```

- [ ] **Step 8: (Optional) Manual smoke against the real sources**

Only when you want to validate end-to-end against live Free-Work and WTTJ.

```bash
npx wrangler dev   # in a separate terminal
curl "http://localhost:8787/__scheduled?cron=*/30+*+*+*+*"
sleep 5
curl "http://localhost:8787/api/candidates?limit=50" | jq '.candidates[] | {source, title}'
```

Expected: within ~10 s of the cron call, `/api/candidates` returns at least one row each with `source: "free-work"` and `source: "wttj"`. If a source returns no rows:
- Check `wrangler dev` logs for the per-adapter error.
- Re-curl the source URL with the same User-Agent — the source may have started rate-limiting.
- If the source consistently 404s, the URL pinned in the adapter has drifted; re-run recon and amend the adapter.

This step is not part of the merge gate — it's a developer sanity check.

---

## Self-Review

**1. Spec coverage:**

- §1 in-scope items:
  - Free-Work adapter → Task 2 ✓
  - WTTJ adapter → Task 3 ✓
  - `fetchText` sibling → Task 0 ✓
  - `parseRssItems` → Task 1 ✓
  - registry wiring → Task 4 Step 1 ✓
  - `fetchTick` consumer update → Task 0 Step 4 ✓
- §1 out-of-scope items: all preserved (no dedup, no schema migration, no new deps, no LinkedIn / Hellowork / Telegram, no source priority, no prefilter tightening, no dashboard change, no CI smoke test).
- §2 subrequest budget: covered implicitly (3 adapters fit; no new tick added).
- §3 architecture: data flow unchanged → Task 4 integration test verifies the 3-adapter loop.
- §3.1 responsibility split: adapters in Task 2/3 do source-shape filtering only (URL params for WTTJ, none needed for Free-Work). Neither imports `profile`.
- §4 components: §4.1 → Task 0; §4.2 → Task 1; §4.3 → Task 2; §4.4 → Task 3; §4.5 → Task 4; §4.6 → Task 0 Step 4; §4.7 → Task 0 Step 3.
- §5 data flow: unchanged — no plan step touches `prefilter` or `insertCandidates`.
- §6 error matrix: adapter try/catch isolation tested in Task 4 (one adapter throws), 304 path tested in Tasks 2 and 3, parse failure path tested in Tasks 2 and 3, RSS malformed → `[]` tested in Task 1.
- §7 configuration: no new env vars, no `wrangler.jsonc` change.
- §8 module layout: matches the per-task file lists.
- §9 testing strategy: fixtures committed once during Tasks 2/3 recon, not regenerated. Step 6 of Task 4 documents the optional smoke.
- §10 acceptance criteria: `npm test` 85+ → Task 4 Step 5 shows 89; integration scenario → Task 4 Step 3; fixture-based adapter unit tests → Tasks 2 and 3; manual smoke → Task 4 Step 8 (explicitly NOT in CI); dashboard renders new sources → README structure update, smoke step confirms manually.
- §11 known omissions: all listed are explicitly left untouched (no plan step addresses them).
- §12 phasing: 5 tasks in the plan correspond exactly to §12's 5-task preview.

**2. Placeholder scan:**

- "TBD" / "TODO" / "implement later": none.
- "Add error handling" / "validate appropriately": none — every catch and validator is shown inline.
- `<PIN_THIS_TO_THE_CHOSEN_URL_FROM_STEP_1>` and `<PIN_THIS_TO_THE_CHOSEN_URL_WITH_contract_type=freelance_AND_country=FR>` appear in Task 2 Step 5 and Task 3 Step 6 — these are **intentional** discovery markers, paired with explicit recon steps (Task 2 Step 1 and Task 3 Step 1) that produce the value. Not placeholders in the failed-plan sense.
- Each test step shows actual test code; each implementation step shows actual implementation code; each commit step shows the exact `git add` and `git commit -m` command.

**3. Type consistency:**

- `FetchText` declared in Task 0 (`src/sources/http.ts`), imported in `types.ts` extension in the same task, used as `ctx.fetchText` in Task 2's adapter and tests.
- `RssItem` declared in Task 1, consumed by `freeWorkAdapter` in Task 2 (RSS variant).
- `RawMission` (existing) referenced consistently across Tasks 2, 3, 4 — fields `source`, `externalId`, `url`, `title`, `body`, `postedAt` match the existing M1 shape; no drift.
- `AdapterCtx` extended once in Task 0 with `fetchText: FetchText`; Tasks 2 and 3 pass the same shape into their tests' `ctxWith` helper.
- `WttjJob` / `WttjResponse` (Task 3) are scoped to wttj.ts; not referenced elsewhere. The path through `WttjResponse` (`hits.jobs.results`) is documented in a comment so future readers can grep for it if WTTJ's API shape changes.
- Adapter `id` strings (`"free-work"`, `"wttj"`) match between `SourceAdapter.id`, the `source` field on every `RawMission`, and the registry — no typos across tasks.
