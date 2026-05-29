import { describe, expect, it } from "vitest";
import { buildScoringPrompt, STRICT_RETRY_NOTE } from "../../src/scoring/prompt";
import type { ScoringProfile } from "../../src/config";

const profile: ScoringProfile = {
  skills: ["react", "typescript", "node"],
  seniority: "senior",
  tjm: { min: 500, max: 700, lowballBelow: 450 },
  remotePreference: "remote-first",
  killClientTypes: [],
  minDurationMonths: 3,
};

const candidate = {
  source: "reddit",
  externalId: "p1",
  url: "https://x/p1",
  title: "[Hiring] Senior React/TS freelancer, full remote",
  body: "6 months, 600€/j, direct client (no ESN). Start ASAP.",
};

describe("buildScoringPrompt", () => {
  it("returns one system + one user message", () => {
    const { messages } = buildScoringPrompt(candidate, profile);
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("system");
    expect(messages[1].role).toBe("user");
  });

  it("includes the user profile in the system prompt", () => {
    const { messages } = buildScoringPrompt(candidate, profile);
    const sys = messages[0].content;
    expect(sys).toContain("react");
    expect(sys).toContain("typescript");
    expect(sys).toContain("500");
    expect(sys).toContain("700");
    expect(sys).toContain("senior");
  });

  it("puts the candidate text verbatim in the user message", () => {
    const { messages } = buildScoringPrompt(candidate, profile);
    expect(messages[1].content).toContain(candidate.title);
    expect(messages[1].content).toContain(candidate.body);
  });

  it("includes at least two few-shot anchors in the system prompt", () => {
    const { messages } = buildScoringPrompt(candidate, profile);
    const sys = messages[0].content;
    // Anchors document what "score 80" and "score 20" look like.
    expect(sys).toMatch(/score\s*[:=]?\s*80/i);
    expect(sys).toMatch(/score\s*[:=]?\s*20/i);
  });

  it("the strict retry variant appends a forcing note to the system message", () => {
    const { messages } = buildScoringPrompt(candidate, profile, { strict: true });
    expect(messages[0].content).toContain(STRICT_RETRY_NOTE);
  });
});
