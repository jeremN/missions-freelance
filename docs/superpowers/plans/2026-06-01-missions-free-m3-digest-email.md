# M3 — Daily Digest Email + Access Protection — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Email the owner a once-daily digest of new high-scoring missions, and lock the worker URL to the owner via Cloudflare Access.

**Architecture:** A new `digest` cron (`0 5 * * *`) runs `runDigestTick`, which selects un-notified, real missions scoring ≥70 (the `notified` column + index already exist — no migration), renders an HTML+text email, sends it via a minimal Resend client behind an injectable `EmailLike` seam (mirroring the existing `AiLike` seam), then flips `notified=1` — **send-then-mark = at-least-once delivery**. Access protection is a one-time Cloudflare-dashboard config, captured as a runbook in Task 9.

**Tech Stack:** TypeScript, Cloudflare Workers (cron + D1), Resend HTTP API (no SDK), Vitest with `@cloudflare/vitest-pool-workers`. Spec: `docs/superpowers/specs/2026-06-01-missions-free-m3-digest-email-design.md`.

**Conventions (from the repo + user rules):** TDD (failing test → confirm fail → implement → confirm pass → commit). Commits are a single conventional-commits subject line, **no body, no `Co-Authored-By` trailer**. Run hooks normally; never `--no-verify`. Work happens on branch `m3-digest-email` (already created).

**Test commands:**
- Single file: `npx vitest run <path>`
- Full suite: `npm test`
- Types: `npx tsc --noEmit`

---

## Task 1: Foundation — config constants + Env secret fields

Pure additions consumed by later tasks. No behavior yet, so verification is a typecheck (TDD's failing-test step doesn't apply to constant/interface declarations).

**Files:**
- Modify: `src/config.ts` (append a new section)
- Modify: `src/types/env.ts`

- [ ] **Step 1: Add the M3 config constants**

Append to `src/config.ts`:

```ts
// ----- M3 (digest email) ----------------------------------------------------

/** Minimum score for a mission to be worth emailing (matches the dashboard "good" band). */
export const DIGEST_MIN_SCORE = 70;

/** Max missions per digest email; any overflow rolls into the next day's digest. */
export const DIGEST_MAX_ITEMS = 20;
```

- [ ] **Step 2: Add the email secrets to `Env`**

Replace the contents of `src/types/env.ts` with:

```ts
export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  AI: Ai;
  /** Resend API key (secret). */
  RESEND_API_KEY: string;
  /** Digest recipient — the owner's inbox (secret, keeps the address out of the public repo). */
  DIGEST_TO: string;
  /** Digest "from" address (secret) — "onboarding@resend.dev" until a domain is verified. */
  DIGEST_FROM: string;
}
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS (no errors — new fields have no consumers yet; `test/env.d.ts` already does `ProvidedEnv extends Env`, so tests pick them up automatically).

- [ ] **Step 4: Commit**

```bash
git add src/config.ts src/types/env.ts
git commit -m "feat(config): add M3 digest constants and Resend env secrets"
```

---

## Task 2: HTML-escape utility

Worker-side port of the dashboard's `escapeHtml`/`safeUrl` (currently only in `public/app.js`). The email renderer interpolates scraped, attacker-influenced text, so this is the injection guard.

**Files:**
- Create: `src/email/html.ts`
- Test: `test/email/html.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/email/html.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { escapeHtml, safeUrl } from "../../src/email/html";

describe("email/html", () => {
  it("escapes the five HTML-significant characters", () => {
    expect(escapeHtml(`<b>"x" & 'y'</b>`)).toBe(
      "&lt;b&gt;&quot;x&quot; &amp; &#39;y&#39;&lt;/b&gt;",
    );
  });

  it("passes through http(s) URLs and blocks dangerous schemes", () => {
    expect(safeUrl("https://example.com/x")).toBe("https://example.com/x");
    expect(safeUrl("http://example.com")).toBe("http://example.com");
    expect(safeUrl("javascript:alert(1)")).toBe("#");
    expect(safeUrl("data:text/html,x")).toBe("#");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/email/html.test.ts`
Expected: FAIL — cannot resolve `../../src/email/html`.

- [ ] **Step 3: Write minimal implementation**

Create `src/email/html.ts`:

```ts
const HTML_ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Escape the five HTML-significant characters. Ported from public/app.js. */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => HTML_ENTITIES[ch] ?? ch);
}

/**
 * Allow only http/https URLs; anything else (javascript:, data:, …) collapses
 * to "#". escapeHtml defuses HTML injection but not dangerous URL schemes.
 */
export function safeUrl(u: string): string {
  return /^https?:\/\//i.test(u) ? u : "#";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/email/html.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/email/html.ts test/email/html.test.ts
git commit -m "feat(email): add worker-side escapeHtml/safeUrl helper"
```

---

## Task 3: `renderDigest` — pure email rendering

**Files:**
- Create: `src/email/digest.ts`
- Test: `test/email/digest.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/email/digest.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { renderDigest } from "../../src/email/digest";
import type { MissionRow } from "../../src/store/missions";

const NOW = new Date("2026-06-01T05:00:00.000Z");

function mission(over: Partial<MissionRow> = {}): MissionRow {
  return {
    id: 1,
    candidateId: 1,
    source: "free-work",
    url: "https://example.com/m/1",
    title: "Senior React mission",
    isRealMission: true,
    rateEurDay: 600,
    duration: "6 mois",
    remote: "full",
    location: null,
    skills: ["react"],
    clientType: "direct",
    score: 80,
    reason: "Stack match, remote, day-rate in range.",
    rawResponse: "{}",
    firstSeen: "2026-06-01T00:00:00.000Z",
    lastSeen: "2026-06-01T00:00:00.000Z",
    notified: false,
    ...over,
  };
}

describe("renderDigest", () => {
  it("subject reflects the count and the top score", () => {
    const { subject } = renderDigest(
      [mission({ id: 1, score: 92 }), mission({ id: 2, score: 71 })],
      { now: NOW, minScore: 70 },
    );
    expect(subject).toBe("missions-free — 2 new (top 92)");
  });

  it("html contains each mission's title, score, and link", () => {
    const { html, text } = renderDigest([mission({ score: 88 })], {
      now: NOW,
      minScore: 70,
    });
    expect(html).toContain("Senior React mission");
    expect(html).toContain("88");
    expect(html).toContain('href="https://example.com/m/1"');
    expect(text).toContain("Senior React mission");
    expect(text).toContain("https://example.com/m/1");
  });

  it("handles an empty selection without crashing", () => {
    const { subject, html, text } = renderDigest([], { now: NOW, minScore: 70 });
    expect(subject).toBe("missions-free — nothing new");
    expect(html).toContain("No new missions");
    expect(text).toContain("No new missions");
  });

  it("escapes HTML in scraped fields and blocks dangerous link schemes", () => {
    const { html } = renderDigest(
      [
        mission({
          title: "<script>alert(1)</script>",
          url: "javascript:alert(1)",
          reason: 'a & b "c"',
        }),
      ],
      { now: NOW, minScore: 70 },
    );
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain('href="#"');
    expect(html).toContain("a &amp; b &quot;c&quot;");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/email/digest.test.ts`
Expected: FAIL — cannot resolve `../../src/email/digest`.

- [ ] **Step 3: Write minimal implementation**

Create `src/email/digest.ts`:

```ts
import type { MissionRow } from "../store/missions";
import { escapeHtml, safeUrl } from "./html";

export interface DigestOpts {
  now: Date;
  minScore: number;
}

export interface RenderedDigest {
  subject: string;
  html: string;
  text: string;
}

function rate(m: MissionRow): string {
  return m.rateEurDay != null ? `${m.rateEurDay}€/j` : "—";
}

function metaLine(m: MissionRow): string {
  const loc = m.location ? ` · ${m.location}` : "";
  return `${rate(m)} · ${m.remote} · ${m.source} · ${m.duration || "—"}${loc}`;
}

/** Pure render of the digest email. No I/O. All scraped fields are HTML-escaped. */
export function renderDigest(
  missions: MissionRow[],
  _opts: DigestOpts,
): RenderedDigest {
  if (missions.length === 0) {
    return {
      subject: "missions-free — nothing new",
      html: "<p>No new missions above the threshold.</p>",
      text: "No new missions above the threshold.",
    };
  }

  const top = Math.max(...missions.map((m) => m.score));
  const subject = `missions-free — ${missions.length} new (top ${top})`;

  const htmlItems = missions
    .map((m) => {
      const href = escapeHtml(safeUrl(m.url));
      return `  <li>
    <strong>[${escapeHtml(String(m.score))}]</strong>
    <a href="${href}">${escapeHtml(m.title)}</a><br>
    <small>${escapeHtml(metaLine(m))}</small><br>
    <span>${escapeHtml(m.reason || "")}</span>
  </li>`;
    })
    .join("\n");

  const html = `<h2>${escapeHtml(subject)}</h2>\n<ul>\n${htmlItems}\n</ul>`;

  const textItems = missions
    .map(
      (m) =>
        `[${m.score}] ${m.title}\n  ${metaLine(m)}\n  ${m.reason || ""}\n  ${m.url}`,
    )
    .join("\n\n");

  const text = `${subject}\n\n${textItems}`;

  return { subject, html, text };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/email/digest.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/email/digest.ts test/email/digest.test.ts
git commit -m "feat(email): add pure renderDigest (html + text, escaped)"
```

---

## Task 4: Resend client behind `EmailLike`

Mirrors the `AiLike` seam in `src/scoring/ai.ts`: a narrow interface the pipeline depends on, with a real implementation that calls the Resend HTTP API. The optional `fetchImpl` parameter makes it unit-testable without global stubbing.

**Files:**
- Create: `src/email/resend.ts`
- Test: `test/email/resend.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/email/resend.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { createResendClient, type EmailMessage } from "../../src/email/resend";

const msg: EmailMessage = {
  from: "onboarding@resend.dev",
  to: "owner@example.com",
  subject: "s",
  html: "<p>h</p>",
  text: "h",
};

describe("email/resend", () => {
  it("POSTs to the Resend API with bearer auth and a JSON body", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ id: "1" }), { status: 200 }),
    );
    await createResendClient("key_123", fetchImpl as unknown as typeof fetch).send(
      msg,
    );

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer key_123");
    expect(headers["content-type"]).toContain("application/json");
    const sent = JSON.parse(init.body as string);
    expect(sent).toMatchObject({
      from: "onboarding@resend.dev",
      to: ["owner@example.com"],
      subject: "s",
    });
  });

  it("throws on a non-2xx response", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 422 }));
    await expect(
      createResendClient("k", fetchImpl as unknown as typeof fetch).send(msg),
    ).rejects.toThrow(/422/);
  });

  it("resolves on a 2xx response", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 200 }));
    await expect(
      createResendClient("k", fetchImpl as unknown as typeof fetch).send(msg),
    ).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/email/resend.test.ts`
Expected: FAIL — cannot resolve `../../src/email/resend`.

- [ ] **Step 3: Write minimal implementation**

Create `src/email/resend.ts`:

```ts
export interface EmailMessage {
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
}

/** What the digest pipeline needs from an email transport — narrowed so tests can fake it. */
export interface EmailLike {
  send(msg: EmailMessage): Promise<void>;
}

const RESEND_ENDPOINT = "https://api.resend.com/emails";

/**
 * Minimal Resend client (no SDK). `send` POSTs the message and THROWS on any
 * non-2xx response — the digest tick relies on that throw to avoid marking
 * missions `notified` when delivery failed.
 */
export function createResendClient(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): EmailLike {
  return {
    async send(msg: EmailMessage): Promise<void> {
      const res = await fetchImpl(RESEND_ENDPOINT, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          from: msg.from,
          to: [msg.to],
          subject: msg.subject,
          html: msg.html,
          text: msg.text,
        }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`resend send failed: ${res.status} ${body.slice(0, 200)}`);
      }
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/email/resend.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/email/resend.ts test/email/resend.test.ts
git commit -m "feat(email): add Resend client behind EmailLike seam"
```

---

## Task 5: Store — `getUnnotifiedMissions` + `markNotified`

**Files:**
- Modify: `src/store/missions.ts` (append two functions)
- Test: `test/store/missions.test.ts` (append a `describe` block)

- [ ] **Step 1: Write the failing test**

Append to `test/store/missions.test.ts` (after the existing top-level `describe`, inside the same file). It reuses the file's existing `seedCandidate` helper and `beforeEach` table cleanup, and adds `getUnnotifiedMissions`/`markNotified` to the import from `../../src/store/missions`:

```ts
describe("store/missions — digest selection", () => {
  async function seedMission(
    externalId: string,
    over: { score: number; isRealMission?: boolean },
  ): Promise<number> {
    const candidateId = await seedCandidate(externalId);
    await upsertMission(env.DB, {
      candidateId,
      source: "reddit",
      url: `https://x/${externalId}`,
      title: `mission ${externalId}`,
      isRealMission: over.isRealMission ?? true,
      rateEurDay: 600,
      duration: "6 mois",
      remote: "full",
      location: null,
      skills: ["react"],
      clientType: "direct",
      score: over.score,
      reason: "",
      rawResponse: "{}",
    });
    return candidateId;
  }

  it("returns only un-notified, real missions at/above minScore, score desc", async () => {
    await seedMission("hi", { score: 90 });
    await seedMission("mid", { score: 72 });
    await seedMission("low", { score: 50 }); // below threshold
    await seedMission("fake", { score: 95, isRealMission: false }); // not a real mission

    const rows = await getUnnotifiedMissions(env.DB, { minScore: 70, limit: 20 });
    expect(rows.map((r) => r.score)).toEqual([90, 72]);
  });

  it("excludes already-notified missions", async () => {
    const cid = await seedMission("hi", { score: 90 });
    const id = (
      await env.DB.prepare("SELECT id FROM missions WHERE candidate_id = ?")
        .bind(cid)
        .first<{ id: number }>()
    )!.id;
    await markNotified(env.DB, [id]);

    const rows = await getUnnotifiedMissions(env.DB, { minScore: 70, limit: 20 });
    expect(rows).toHaveLength(0);
  });

  it("markNotified flips exactly the given ids and is a no-op on []", async () => {
    const a = await seedMission("a", { score: 80 });
    const b = await seedMission("b", { score: 85 });
    const idOf = async (cid: number) =>
      (
        await env.DB.prepare("SELECT id FROM missions WHERE candidate_id = ?")
          .bind(cid)
          .first<{ id: number }>()
      )!.id;
    const idA = await idOf(a);

    await markNotified(env.DB, []); // no-op
    expect(await getUnnotifiedMissions(env.DB, { minScore: 70, limit: 20 })).toHaveLength(2);

    await markNotified(env.DB, [idA]);
    const rows = await getUnnotifiedMissions(env.DB, { minScore: 70, limit: 20 });
    expect(rows.map((r) => r.candidateId)).toEqual([b]);
  });
});
```

Update the import at the top of `test/store/missions.test.ts` from:

```ts
import {
  getMissions,
  getMissionsForCandidate,
  upsertMission,
} from "../../src/store/missions";
```

to:

```ts
import {
  getMissions,
  getMissionsForCandidate,
  getUnnotifiedMissions,
  markNotified,
  upsertMission,
} from "../../src/store/missions";
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/store/missions.test.ts`
Expected: FAIL — `getUnnotifiedMissions`/`markNotified` are not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `src/store/missions.ts`:

```ts
/**
 * Missions eligible for the daily digest: never-notified, real, score ≥ minScore.
 * Served by idx_missions_notified(notified, score).
 */
export async function getUnnotifiedMissions(
  db: D1Database,
  opts: { minScore: number; limit: number },
): Promise<MissionRow[]> {
  const limit = Math.min(opts.limit, 500);
  const { results } = await db
    .prepare(
      `SELECT ${SELECT_COLS} FROM missions
        WHERE notified = 0 AND is_real_mission = 1 AND score >= ?
        ORDER BY score DESC, last_seen DESC
        LIMIT ?`,
    )
    .bind(opts.minScore, limit)
    .all<MissionDbRow>();
  return results.map(hydrate);
}

/** Mark the given mission ids as notified. No-op on an empty list. */
export async function markNotified(db: D1Database, ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => "?").join(", ");
  await db
    .prepare(`UPDATE missions SET notified = 1 WHERE id IN (${placeholders})`)
    .bind(...ids)
    .run();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/store/missions.test.ts`
Expected: PASS (existing tests + 3 new).

- [ ] **Step 5: Commit**

```bash
git add src/store/missions.ts test/store/missions.test.ts
git commit -m "feat(store): add getUnnotifiedMissions + markNotified for digest"
```

---

## Task 6: `runDigestTick` orchestration

Mirrors `runScoreTick`: injectable deps (`email`, `now`), `recordRun` in `finally`, never throws to the scheduler. **Send-then-mark** (at-least-once); on send failure, `notified` is not flipped and the missions roll to tomorrow.

**Files:**
- Create: `src/pipeline/digestTick.ts`
- Test: `test/pipeline/digestTick.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/pipeline/digestTick.test.ts`:

```ts
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { runDigestTick } from "../../src/pipeline/digestTick";
import { insertCandidates } from "../../src/store/db";
import { upsertMission } from "../../src/store/missions";
import type { EmailLike, EmailMessage } from "../../src/email/resend";

beforeEach(async () => {
  await env.DB.exec("DELETE FROM missions");
  await env.DB.exec("DELETE FROM candidates");
  await env.DB.exec("DELETE FROM runs");
});

const NOW = new Date("2026-06-01T05:00:00.000Z");

function recordingEmail(): EmailLike & { calls: EmailMessage[] } {
  const calls: EmailMessage[] = [];
  return {
    calls,
    async send(m) {
      calls.push(m);
    },
  };
}

function throwingEmail(): EmailLike {
  return {
    async send() {
      throw new Error("boom");
    },
  };
}

async function seedMission(
  externalId: string,
  over: { score: number; isRealMission?: boolean },
): Promise<number> {
  await insertCandidates(env.DB, [
    {
      source: "reddit",
      externalId,
      url: `https://x/${externalId}`,
      title: `mission ${externalId}`,
      body: "",
      tjm: 600,
      lowball: false,
    },
  ]);
  const candidateId = (
    await env.DB.prepare("SELECT id FROM candidates WHERE external_id = ?")
      .bind(externalId)
      .first<{ id: number }>()
  )!.id;
  await upsertMission(env.DB, {
    candidateId,
    source: "reddit",
    url: `https://x/${externalId}`,
    title: `mission ${externalId}`,
    isRealMission: over.isRealMission ?? true,
    rateEurDay: 600,
    duration: "6 mois",
    remote: "full",
    location: null,
    skills: ["react"],
    clientType: "direct",
    score: over.score,
    reason: "",
    rawResponse: "{}",
  });
  return candidateId;
}

async function notifiedFor(candidateId: number): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT notified FROM missions WHERE candidate_id = ?",
  )
    .bind(candidateId)
    .first<{ notified: number }>();
  return row!.notified;
}

async function lastDigestStats(): Promise<{ candidates: number; sent: boolean; skipped: boolean }> {
  const row = await env.DB.prepare(
    "SELECT stats FROM runs WHERE tick = 'digest' ORDER BY id DESC LIMIT 1",
  ).first<{ stats: string }>();
  return JSON.parse(row!.stats);
}

describe("runDigestTick", () => {
  it("skips sending and records a run when nothing qualifies", async () => {
    const email = recordingEmail();
    const result = await runDigestTick(env, { email, now: NOW });

    expect(result).toEqual({ candidates: 0, sent: false, skipped: true });
    expect(email.calls).toHaveLength(0);
    expect(await lastDigestStats()).toMatchObject({ candidates: 0, sent: false, skipped: true });
  });

  it("sends one email and marks only the selected missions notified", async () => {
    const hi = await seedMission("hi", { score: 90 });
    const mid = await seedMission("mid", { score: 72 });
    const low = await seedMission("low", { score: 50 }); // excluded
    const email = recordingEmail();

    const result = await runDigestTick(env, { email, now: NOW });

    expect(result).toEqual({ candidates: 2, sent: true, skipped: false });
    expect(email.calls).toHaveLength(1);
    expect(email.calls[0].subject).toBe("missions-free — 2 new (top 90)");
    expect(await notifiedFor(hi)).toBe(1);
    expect(await notifiedFor(mid)).toBe(1);
    expect(await notifiedFor(low)).toBe(0); // never selected
    expect(await lastDigestStats()).toMatchObject({ candidates: 2, sent: true });
  });

  it("does not mark notified when the send fails, and records the failed run", async () => {
    const hi = await seedMission("hi", { score: 90 });

    const result = await runDigestTick(env, { email: throwingEmail(), now: NOW });

    expect(result).toEqual({ candidates: 1, sent: false, skipped: false });
    expect(await notifiedFor(hi)).toBe(0); // rolls to tomorrow
    expect(await lastDigestStats()).toMatchObject({ candidates: 1, sent: false });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/pipeline/digestTick.test.ts`
Expected: FAIL — cannot resolve `../../src/pipeline/digestTick`.

- [ ] **Step 3: Write minimal implementation**

Create `src/pipeline/digestTick.ts`:

```ts
import type { Env } from "../types/env";
import { DIGEST_MAX_ITEMS, DIGEST_MIN_SCORE } from "../config";
import { renderDigest } from "../email/digest";
import { createResendClient, type EmailLike } from "../email/resend";
import { recordRun } from "../store/db";
import { getUnnotifiedMissions, markNotified } from "../store/missions";

export interface DigestTickOptions {
  email?: EmailLike;
  now?: Date;
}

export interface DigestTickResult {
  candidates: number;
  sent: boolean;
  skipped: boolean;
}

/**
 * Daily digest: select un-notified real missions ≥ DIGEST_MIN_SCORE, email them,
 * then mark them notified (send-then-mark = at-least-once). Never throws to the
 * scheduler; failures land in the `runs` audit trail and roll to the next day.
 */
export async function runDigestTick(
  env: Env,
  opts: DigestTickOptions = {},
): Promise<DigestTickResult> {
  const email = opts.email ?? createResendClient(env.RESEND_API_KEY);
  const now = opts.now ?? new Date();
  const startedAt = now.toISOString();

  let candidates = 0;
  let sent = false;
  let skipped = false;

  try {
    const rows = await getUnnotifiedMissions(env.DB, {
      minScore: DIGEST_MIN_SCORE,
      limit: DIGEST_MAX_ITEMS,
    });
    candidates = rows.length;

    if (candidates === 0) {
      skipped = true;
      return { candidates: 0, sent: false, skipped: true };
    }

    const { subject, html, text } = renderDigest(rows, {
      now,
      minScore: DIGEST_MIN_SCORE,
    });
    await email.send({ from: env.DIGEST_FROM, to: env.DIGEST_TO, subject, html, text });
    sent = true;
    await markNotified(env.DB, rows.map((r) => r.id));
    return { candidates, sent: true, skipped: false };
  } catch (err) {
    console.error("digest tick failed:", String(err));
    return { candidates, sent, skipped };
  } finally {
    await recordRun(env.DB, {
      tick: "digest",
      startedAt,
      finishedAt: new Date().toISOString(),
      stats: { candidates, sent, skipped },
    });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/pipeline/digestTick.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/pipeline/digestTick.ts test/pipeline/digestTick.test.ts
git commit -m "feat(pipeline): add runDigestTick (at-least-once digest)"
```

---

## Task 7: Wire the digest cron

**Files:**
- Modify: `wrangler.jsonc:22-24` (the `triggers.crons` array)
- Modify: `src/index.ts:12-21` (the `scheduled` switch)

- [ ] **Step 1: Add the cron trigger**

In `wrangler.jsonc`, change:

```jsonc
  "triggers": {
    "crons": ["*/30 * * * *", "*/15 * * * *"]
  }
```

to:

```jsonc
  "triggers": {
    "crons": ["*/30 * * * *", "*/15 * * * *", "0 5 * * *"]
  }
```

- [ ] **Step 2: Route the cron to `runDigestTick`**

In `src/index.ts`, add the import alongside the existing tick imports:

```ts
import { runDigestTick } from "./pipeline/digestTick";
```

and add a `case` to the `scheduled` switch (after the `*/15` case):

```ts
      case "0 5 * * *":
        ctx.waitUntil(runDigestTick(env));
        break;
```

- [ ] **Step 3: Run the full suite + typecheck**

Run: `npm test`
Expected: PASS — all prior tests plus the new email/digest/store/pipeline tests.

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add wrangler.jsonc src/index.ts
git commit -m "feat: wire 0 5 * * * digest cron to runDigestTick"
```

---

## Task 8: `GET /api/digest/preview` (read-only)

Renders the would-be digest as HTML without sending or mutating `notified`. Deliberate exception to the JSON-only `/api/*` contract.

**Files:**
- Modify: `src/http/api.ts` (imports + one new `case`)
- Test: `test/http/api.test.ts` (extend imports, `beforeEach`, add one test)

- [ ] **Step 1: Write the failing test**

In `test/http/api.test.ts`, update the import block to add `upsertMission`:

```ts
import { handleApi } from "../../src/http/api";
import { insertCandidates, recordRun } from "../../src/store/db";
import { upsertMission } from "../../src/store/missions";
```

Update `beforeEach` to also clear missions (FK enforcement is not guaranteed in the test D1, so clear explicitly):

```ts
beforeEach(async () => {
  await env.DB.exec("DELETE FROM missions");
  await env.DB.exec("DELETE FROM candidates");
  await env.DB.exec("DELETE FROM runs");
});
```

Add this test inside the `describe("handleApi", …)` block:

```ts
  it("GET /api/digest/preview renders HTML and does not mark missions notified", async () => {
    await insertCandidates(env.DB, [
      { source: "reddit", externalId: "a", url: "https://x/a", title: "Senior React", body: "", tjm: 600, lowball: false },
    ]);
    const id = (
      await env.DB.prepare("SELECT id FROM candidates WHERE external_id = 'a'")
        .first<{ id: number }>()
    )!.id;
    await upsertMission(env.DB, {
      candidateId: id,
      source: "reddit",
      url: "https://x/a",
      title: "Senior React",
      isRealMission: true,
      rateEurDay: 600,
      duration: "6 mois",
      remote: "full",
      location: null,
      skills: ["react"],
      clientType: "direct",
      score: 88,
      reason: "great",
      rawResponse: "{}",
    });

    const res = await handleApi(req("/api/digest/preview"), env);
    expect(res?.status).toBe(200);
    expect(res?.headers.get("content-type")).toContain("text/html");
    const html = await res!.text();
    expect(html).toContain("Senior React");

    const row = await env.DB.prepare(
      "SELECT notified FROM missions WHERE candidate_id = ?",
    )
      .bind(id)
      .first<{ notified: number }>();
    expect(row?.notified).toBe(0); // read-only
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/http/api.test.ts`
Expected: FAIL — `/api/digest/preview` returns 404 (route not handled).

- [ ] **Step 3: Write minimal implementation**

In `src/http/api.ts`, add imports below the existing ones:

```ts
import { getMissions, getUnnotifiedMissions } from "../store/missions";
import { renderDigest } from "../email/digest";
import { DIGEST_MAX_ITEMS, DIGEST_MIN_SCORE } from "../config";
```

(Replace the existing `import { getMissions } from "../store/missions";` line with the combined import above.)

Add a `case` before `default:` in the `switch (url.pathname)`:

```ts
      case "/api/digest/preview": {
        const missions = await getUnnotifiedMissions(env.DB, {
          minScore: DIGEST_MIN_SCORE,
          limit: DIGEST_MAX_ITEMS,
        });
        const { html } = renderDigest(missions, {
          now: new Date(),
          minScore: DIGEST_MIN_SCORE,
        });
        return new Response(html, {
          status: 200,
          headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "private, no-store",
          },
        });
      }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/http/api.test.ts`
Expected: PASS (existing tests + the new preview test).

- [ ] **Step 5: Full suite + typecheck + commit**

```bash
npm test           # expect all green
npx tsc --noEmit   # expect no errors
git add src/http/api.ts test/http/api.test.ts
git commit -m "feat(api): add read-only /api/digest/preview"
```

---

## Task 9: Deploy, secrets, and Access protection (ops)

Manual/ops task — no repo code. Requires a Resend account and Cloudflare dashboard access. Run from the repo root.

- [ ] **Step 1: Create a Resend account + API key**

Sign up at resend.com **using `jeremie.nehlil.freelance@proton.me`** (so the shared `onboarding@resend.dev` sender is allowed to deliver to it without a verified domain). Create an API key (Full Access or Sending Access).

- [ ] **Step 2: Set the three secrets**

```bash
npx wrangler secret put RESEND_API_KEY    # paste the Resend key
npx wrangler secret put DIGEST_TO         # jeremie.nehlil.freelance@proton.me
npx wrangler secret put DIGEST_FROM       # onboarding@resend.dev
```

- [ ] **Step 3: Deploy**

```bash
npm run deploy
```
Expected: new version published; `wrangler` lists 3 cron triggers (`*/30`, `*/15`, `0 5 * * *`). No new migration to apply (the `notified` column already exists).

- [ ] **Step 4: Enable Cloudflare Access (Part A runbook)**

In the Cloudflare dashboard:
1. **Workers & Pages → `missions-free` → Settings → Domains & Routes → `workers.dev` → Enable Cloudflare Access.**
2. In the auto-created Zero Trust Access app, add a policy: **Action = Allow**, **Include = Emails = `jeremie.nehlil.freelance@proton.me`**.
3. Login method: **one-time PIN** (default; no identity provider needed).

- [ ] **Step 5: Verify the gate + the preview**

```bash
curl -sI https://missions-free.jeremn-code.workers.dev/         # expect 302 → *.cloudflareaccess.com
curl -sI https://missions-free.jeremn-code.workers.dev/api/stats   # expect 302 (gated too)
```
Then in a browser, log in via one-time PIN and open
`https://missions-free.jeremn-code.workers.dev/api/digest/preview` — confirm a sane email renders against live data. Confirm the next `*/15` score run still appears in the dashboard (cron unaffected by the edge gate).

- [ ] **Step 6: Update the handoff**

Edit `docs/HANDOFF.md`: mark M3 shipped (Access + digest), record the new `0 5 * * *` cron, note the three secrets and that the digest reads `runs` with `tick = "digest"`, and move any now-resolved items out of the deferred list. Then:

```bash
git add docs/HANDOFF.md
git commit -m "docs: refresh HANDOFF for post-M3 (access + digest)"
```

- [ ] **Step 7: Integrate the branch**

Use superpowers:finishing-a-development-branch to choose merge vs PR (do not merge to `main` unprompted — confirm with the owner first).

---

## Self-review (completed by plan author)

**Spec coverage:** Part A → Task 9 (steps 4–5). Part B: cron `0 5 * * *` → Task 7; `resend.ts`/`EmailLike` → Task 4; `digest.ts` render + escaping → Tasks 2–3; `digestTick.ts` → Task 6; `getUnnotifiedMissions`/`markNotified` → Task 5; `/api/digest/preview` → Task 8; config constants + env secrets → Task 1; secrets/deploy → Task 9; HANDOFF → Task 9 step 6. At-least-once (§5) → Task 6 (send-then-mark, catch-not-rethrow). Error handling (§6) → Task 6 (catch + recordRun in finally) + Task 4 (throw on non-2xx). Testing (§8) → Tasks 2–8 each ship their tests. ✅ No gaps.

**Placeholder scan:** No TBD/TODO; every code step shows complete code; every command has an expected result. ✅

**Type consistency:** `EmailMessage`/`EmailLike` defined in Task 4, consumed identically in Tasks 6. `renderDigest(missions, { now, minScore })` signature defined in Task 3, called the same way in Tasks 6 and 8. `getUnnotifiedMissions(db, { minScore, limit })` / `markNotified(db, ids)` defined in Task 5, called identically in Tasks 6 and 8. `DigestTickResult { candidates, sent, skipped }` returned in Task 6, asserted identically in its tests. `DIGEST_MIN_SCORE`/`DIGEST_MAX_ITEMS` defined in Task 1, imported in Tasks 6 and 8. ✅
