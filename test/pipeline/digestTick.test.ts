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

  it("sends the top-N real missions and marks only those notified", async () => {
    const hi = await seedMission("hi", { score: 90 });
    const mid = await seedMission("mid", { score: 72 });
    const low = await seedMission("low", { score: 50 }); // now INCLUDED (no floor)
    const fake = await seedMission("fake", { score: 95, isRealMission: false }); // excluded
    const email = recordingEmail();

    const result = await runDigestTick(env, { email, now: NOW });

    expect(result).toEqual({ candidates: 3, sent: true, skipped: false });
    expect(email.calls).toHaveLength(1);
    expect(email.calls[0].subject).toBe("missions-free — 3 new (top 90)");
    expect(await notifiedFor(hi)).toBe(1);
    expect(await notifiedFor(mid)).toBe(1);
    expect(await notifiedFor(low)).toBe(1); // included now
    expect(await notifiedFor(fake)).toBe(0); // excluded: is_real_mission = 0
    expect(await lastDigestStats()).toMatchObject({ candidates: 3, sent: true });
  });

  it("caps the digest at DIGEST_TOP_N and rolls the rest over un-notified", async () => {
    // DIGEST_TOP_N is 5 — seed 6 real missions so the lowest-scored must roll to tomorrow.
    const rolled = await seedMission("roll", { score: 10 });
    for (const [ext, score] of [["a", 95], ["b", 90], ["c", 85], ["d", 80], ["e", 75]] as const) {
      await seedMission(ext, { score });
    }
    const email = recordingEmail();

    const result = await runDigestTick(env, { email, now: NOW });

    expect(result.candidates).toBe(5);
    expect(result.sent).toBe(true);
    expect(await notifiedFor(rolled)).toBe(0); // below the top-5 cap → competes tomorrow
  });

  it("does not mark notified when the send fails, and records the failed run", async () => {
    const hi = await seedMission("hi", { score: 90 });

    const result = await runDigestTick(env, { email: throwingEmail(), now: NOW });

    expect(result).toEqual({ candidates: 1, sent: false, skipped: false });
    expect(await notifiedFor(hi)).toBe(0); // rolls to tomorrow
    expect(await lastDigestStats()).toMatchObject({ candidates: 1, sent: false });
  });
});
