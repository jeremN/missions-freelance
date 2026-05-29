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
