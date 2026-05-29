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
