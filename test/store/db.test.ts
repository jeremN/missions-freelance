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
