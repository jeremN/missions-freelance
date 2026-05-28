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
