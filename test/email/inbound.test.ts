import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { handleInboundEmail } from "../../src/email/inbound";
import { getCandidates, getRecentRuns } from "../../src/store/db";

function eml(from: string, bodyLines: string[]): ForwardableEmailMessage {
  const raw = [
    `From: Alerts <${from}>`,
    "To: missions@example.com",
    'Subject: nouvelles offres',
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "",
    ...bodyLines,
  ].join("\r\n");
  return {
    from,
    raw: new Response(raw).body,
  } as unknown as ForwardableEmailMessage;
}

const LINKEDIN_BODY = [
  "Senior React Engineer",
  "Acme · Paris (Remote)",
  "https://www.linkedin.com/comm/jobs/view/700000001/?trk=eml",
  "",
  "TypeScript Lead",
  "Globex · Lyon",
  "https://www.linkedin.com/comm/jobs/view/700000002/?trk=eml",
];

beforeEach(async () => {
  await env.DB.exec("DELETE FROM candidates");
  await env.DB.exec("DELETE FROM runs");
});

describe("handleInboundEmail", () => {
  it("ingests LinkedIn alert jobs as candidates and records an email run", async () => {
    await handleInboundEmail(eml("jobalerts-noreply@linkedin.com", LINKEDIN_BODY), env);

    const cands = await getCandidates(env.DB, { limit: 10 });
    const linkedin = cands.filter((c) => c.source === "linkedin");
    expect(linkedin).toHaveLength(2);
    expect(linkedin.map((c) => c.externalId).sort()).toEqual(["700000001", "700000002"]);

    const runs = await getRecentRuns(env.DB, 10);
    const emailRun = runs.find((r) => r.tick === "email");
    expect(emailRun).toBeTruthy();
    expect((emailRun!.stats as { inserted: number }).inserted).toBe(2);
  });

  it("ignores emails from unknown senders (no insert, no run)", async () => {
    await handleInboundEmail(eml("noreply@evil.com", LINKEDIN_BODY), env);

    expect(await getCandidates(env.DB, { limit: 10 })).toHaveLength(0);
    const runs = await getRecentRuns(env.DB, 10);
    expect(runs.find((r) => r.tick === "email")).toBeUndefined();
  });

  it("does not throw on a malformed body and still records an email run", async () => {
    const bad = {
      from: "jobalerts-noreply@linkedin.com",
      raw: new Response("%%% not a valid mime message %%%").body,
    } as unknown as ForwardableEmailMessage;

    await expect(handleInboundEmail(bad, env)).resolves.toBeUndefined();
    expect(await getCandidates(env.DB, { limit: 10 })).toHaveLength(0);
    const runs = await getRecentRuns(env.DB, 10);
    expect(runs.find((r) => r.tick === "email")).toBeTruthy();
  });
});
