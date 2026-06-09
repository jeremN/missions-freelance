import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { runDigestTick } from "../../src/pipeline/digestTick";
import { insertCandidates } from "../../src/store/db";
import { upsertMission } from "../../src/store/missions";
import type { EmailLike, EmailMessage } from "../../src/email/resend";
import type { LinkValidator } from "../../src/pipeline/linkHealth";

const okValidator: LinkValidator = {
  async check() {
    return { ok: true, status: 200 };
  },
};

function validatorFailing(failUrls: Set<string>): LinkValidator {
  return {
    async check(url) {
      return failUrls.has(url)
        ? { ok: false, status: 404 }
        : { ok: true, status: 200 };
    },
  };
}

async function setValidationFails(candidateId: number, n: number): Promise<void> {
  await env.DB.prepare(
    "UPDATE missions SET validation_fails = ? WHERE candidate_id = ?",
  )
    .bind(n, candidateId)
    .run();
}

async function validationFailsFor(candidateId: number): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT validation_fails AS v FROM missions WHERE candidate_id = ?",
  )
    .bind(candidateId)
    .first<{ v: number }>();
  return row!.v;
}

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
    const result = await runDigestTick(env, { email, validator: okValidator, now: NOW });

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

    const result = await runDigestTick(env, { email, validator: okValidator, now: NOW });

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

    const result = await runDigestTick(env, { email, validator: okValidator, now: NOW });

    expect(result.candidates).toBe(5);
    expect(result.sent).toBe(true);
    expect(await notifiedFor(rolled)).toBe(0); // below the top-5 cap → competes tomorrow
  });

  it("does not mark notified when the send fails, and records the failed run", async () => {
    const hi = await seedMission("hi", { score: 90 });

    const result = await runDigestTick(env, { email: throwingEmail(), validator: okValidator, now: NOW });

    expect(result).toEqual({ candidates: 1, sent: false, skipped: false });
    expect(await notifiedFor(hi)).toBe(0); // rolls to tomorrow
    expect(await lastDigestStats()).toMatchObject({ candidates: 1, sent: false });
  });

  it("drops a broken link and backfills so a full digest still ships", async () => {
    // 6 real missions; the score-85 one ("c") has a broken link.
    for (const [ext, score] of [
      ["a", 95],
      ["b", 90],
      ["c", 85],
      ["d", 80],
      ["e", 75],
      ["f", 70],
    ] as const) {
      await seedMission(ext, { score });
    }
    const email = recordingEmail();

    const result = await runDigestTick(env, {
      email,
      validator: validatorFailing(new Set(["https://x/c"])),
      now: NOW,
    });

    expect(result).toEqual({ candidates: 5, sent: true, skipped: false });
    expect(email.calls[0].subject).toBe("missions-free — 5 new (top 95)");
    expect(await lastDigestStats()).toMatchObject({
      pool: 6,
      dropped: 1,
      gaveUp: 0,
      sent: true,
    });
  });

  it("leaves a dropped-but-not-retired mission un-notified, and notifies the backfill", async () => {
    const c = await (async () => {
      let cid = 0;
      for (const [ext, score] of [
        ["a", 95],
        ["b", 90],
        ["c", 85],
        ["d", 80],
        ["e", 75],
        ["f", 70],
      ] as const) {
        const id = await seedMission(ext, { score });
        if (ext === "c") cid = id;
      }
      return cid;
    })();

    await runDigestTick(env, {
      email: recordingEmail(),
      validator: validatorFailing(new Set(["https://x/c"])),
      now: NOW,
    });

    expect(await notifiedFor(c)).toBe(0); // dropped, fails=1 (< 3) -> competes tomorrow
    expect(await validationFailsFor(c)).toBe(1); // incremented
  });

  it("retires a mission after DIGEST_GIVE_UP_AFTER consecutive failures", async () => {
    const dead = await seedMission("dead", { score: 90 });
    await setValidationFails(dead, 2); // one more failure crosses the threshold (3)
    const email = recordingEmail();

    const result = await runDigestTick(env, {
      email,
      validator: validatorFailing(new Set(["https://x/dead"])),
      now: NOW,
    });

    expect(result).toEqual({ candidates: 0, sent: false, skipped: true });
    expect(email.calls).toHaveLength(0);
    expect(await notifiedFor(dead)).toBe(1); // given up -> retired even with no send
    expect(await lastDigestStats()).toMatchObject({ pool: 1, dropped: 1, gaveUp: 1 });
  });

  it("resets the failure counter when a previously-failing link recovers", async () => {
    let f = 0;
    for (const [ext, score] of [
      ["a", 95],
      ["b", 90],
      ["c", 85],
      ["d", 80],
      ["e", 75],
      ["f", 70],
    ] as const) {
      const id = await seedMission(ext, { score });
      if (ext === "f") f = id; // rank 6 -- outside the top-5, so passed-but-not-sent
    }
    await setValidationFails(f, 2);

    await runDigestTick(env, { email: recordingEmail(), validator: okValidator, now: NOW });

    expect(await notifiedFor(f)).toBe(0); // healthy but not in the top-5
    expect(await validationFailsFor(f)).toBe(0); // recovered -> debt cleared
  });

  it("credits a recovery even when the send fails (counter tracks link, not email)", async () => {
    // hi recovered today (validator OK) but Resend throws → not notified. Its
    // failure streak must still reset: the link was healthy, only delivery failed.
    const hi = await seedMission("hi", { score: 90 });
    await setValidationFails(hi, 2);

    const result = await runDigestTick(env, {
      email: throwingEmail(),
      validator: okValidator,
      now: NOW,
    });

    expect(result).toEqual({ candidates: 1, sent: false, skipped: false });
    expect(await notifiedFor(hi)).toBe(0); // send failed → competes again tomorrow
    expect(await validationFailsFor(hi)).toBe(0); // recovery credited despite send failure
  });

  it("retires a dead mission and ships the healthy ones in the same run", async () => {
    let dead = 0;
    for (const [ext, score] of [
      ["a", 95],
      ["b", 90],
      ["dead", 88],
      ["d", 80],
      ["e", 75],
      ["f", 70],
    ] as const) {
      const id = await seedMission(ext, { score });
      if (ext === "dead") dead = id;
    }
    await setValidationFails(dead, 2); // its failure today crosses the threshold
    const email = recordingEmail();

    const result = await runDigestTick(env, {
      email,
      validator: validatorFailing(new Set(["https://x/dead"])),
      now: NOW,
    });

    expect(result).toEqual({ candidates: 5, sent: true, skipped: false });
    expect(await notifiedFor(dead)).toBe(1); // retired (given up)
    expect(email.calls[0].html).not.toContain("https://x/dead");
    expect(await lastDigestStats()).toMatchObject({
      pool: 6,
      dropped: 1,
      gaveUp: 1,
      sent: true,
    });
  });
});
