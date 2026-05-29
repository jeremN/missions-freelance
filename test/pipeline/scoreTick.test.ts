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
