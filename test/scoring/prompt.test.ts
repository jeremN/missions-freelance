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

  it("separates is_real_mission from the fit score as independent judgments", () => {
    const { messages } = buildScoringPrompt(candidate, profile);
    const sys = messages[0].content;
    expect(sys).toContain("is_real_mission");
    expect(sys).toMatch(/independent/i);
    expect(sys).toMatch(/score/i);
  });

  it("makes stack fit the dominant scoring factor and names off-stack as low", () => {
    const { messages } = buildScoringPrompt(candidate, profile);
    const sys = messages[0].content;
    expect(sys).toMatch(/stack fit/i);
    expect(sys).toMatch(/dominant/i);
  });

  it("does not contain the old copy-bait example answer", () => {
    const { messages } = buildScoringPrompt(candidate, profile);
    const sys = messages[0].content;
    expect(sys).not.toContain("Stack match, in-range TJM, full remote, direct client");
    expect(sys).not.toMatch(/score\s*[:=]\s*80\b/);
  });

  it("instructs the reason to cite concrete details from the post", () => {
    const { messages } = buildScoringPrompt(candidate, profile);
    const sys = messages[0].content;
    expect(sys).toMatch(/reason/i);
    expect(sys).toMatch(/concrete/i);
  });

  it("the strict retry variant appends a forcing note to the system message", () => {
    const { messages } = buildScoringPrompt(candidate, profile, { strict: true });
    expect(messages[0].content).toContain(STRICT_RETRY_NOTE);
  });
});
