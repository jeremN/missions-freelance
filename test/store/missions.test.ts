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
    expect(second.lastSeen > first.lastSeen).toBe(true); // advanced strictly
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
