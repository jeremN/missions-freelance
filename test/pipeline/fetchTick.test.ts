import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runFetchTick } from "../../src/pipeline/fetchTick";
import { getCandidates, getSourceState, setSourceState } from "../../src/store/db";
import type { SourceAdapter } from "../../src/sources/types";

beforeEach(async () => {
  await env.DB.exec("DELETE FROM candidates");
  await env.DB.exec("DELETE FROM source_state");
  await env.DB.exec("DELETE FROM runs");
});

const stubAdapter = (rows: number): SourceAdapter => ({
  id: "stub",
  enabled: true,
  fetch: vi.fn(async () => ({
    missions: Array.from({ length: rows }, (_, i) => ({
      source: "stub",
      externalId: `id-${i}`,
      url: `https://x/${i}`,
      title: i === 0 ? "Senior React mission, 600€/j" : "COBOL mainframe role",
      body: "",
    })),
  })),
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

  it("persists the etag returned by the adapter", async () => {
    const adapter: SourceAdapter = {
      id: "etag-src",
      enabled: true,
      fetch: vi.fn(async () => ({
        missions: [],
        state: { etag: 'W/"v42"', lastModified: "Wed, 28 May 2026 09:00:00 GMT" },
      })),
    };
    await runFetchTick(env, {
      adapters: [adapter],
      profile: { skills: ["x"], hardKill: [], tjm: { lowballBelow: 450 } },
    });
    const state = await getSourceState(env.DB, "etag-src");
    expect(state?.etag).toBe('W/"v42"');
    expect(state?.lastModified).toBe("Wed, 28 May 2026 09:00:00 GMT");
  });

  it("preserves the existing etag when the adapter doesn't return one (e.g. 304)", async () => {
    await setSourceState(env.DB, { source: "etag-src", etag: 'W/"old"' });
    const adapter: SourceAdapter = {
      id: "etag-src",
      enabled: true,
      // No `state` in the return — simulates a 304 / no-op fetch.
      fetch: vi.fn(async () => ({ missions: [] })),
    };
    await runFetchTick(env, {
      adapters: [adapter],
      profile: { skills: ["x"], hardKill: [], tjm: { lowballBelow: 450 } },
    });
    const state = await getSourceState(env.DB, "etag-src");
    expect(state?.etag).toBe('W/"old"');
  });

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

    // Inline the minimum profile this test needs — avoids ghost breakage if
    // someone edits src/config.ts skills/hardKill in an unrelated change.
    const result = await runFetchTick(env, {
      adapters: [adapterA, adapterB],
      profile: { skills: ["react"], hardKill: [], tjm: { lowballBelow: 450 } },
    });
    expect(result.errors).toBe(1);
    expect(result.fetched).toBe(1); // only A
    expect(result.inserted).toBeGreaterThanOrEqual(1);

    // A produced rows; B is logged but not in candidates.
    const rows = await env.DB.prepare(
      "SELECT source FROM candidates ORDER BY source",
    ).all<{ source: string }>();
    const sources = rows.results.map((r) => r.source);
    expect(sources).toContain("a");
    expect(sources).not.toContain("b");

    // The run was recorded with adapters=2 even though one threw.
    const run = await env.DB.prepare(
      "SELECT stats FROM runs WHERE tick = 'fetch' ORDER BY id DESC LIMIT 1",
    ).first<{ stats: string }>();
    const stats = JSON.parse(run!.stats);
    expect(stats.adapters).toBe(2);
    expect(stats.errors).toBe(1);
  });
});
