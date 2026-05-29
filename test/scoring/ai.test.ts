import { afterEach, describe, expect, it, vi } from "vitest";
import { scoreCandidate, type AiLike, type AiResponse } from "../../src/scoring/ai";
import { STRICT_RETRY_NOTE } from "../../src/scoring/prompt";
import type { ScoringProfile } from "../../src/config";

const profile: ScoringProfile = {
  skills: ["react"],
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
  title: "[Hiring] Senior React, 6 mois, full remote, 600€/j",
  body: "Direct client.",
};

const goodArgs = {
  is_real_mission: true,
  rate_eur_per_day: 600,
  duration: "6 mois",
  remote: "full",
  location: null,
  skills: ["react"],
  client_type: "direct",
  score: 80,
  reason: "Stack + rate + remote.",
};

function aiReturning(responses: AiResponse[]): AiLike {
  let i = 0;
  return {
    run: vi.fn(async () => {
      const r = responses[Math.min(i, responses.length - 1)];
      i += 1;
      return r;
    }),
  };
}

afterEach(() => vi.restoreAllMocks());

describe("scoreCandidate", () => {
  it("returns parsed extraction + neurons on a successful tool-call", async () => {
    const ai = aiReturning([
      {
        tool_calls: [
          {
            function: { name: "extract_mission", arguments: JSON.stringify(goodArgs) },
          },
        ],
        usage: { neurons: 210 },
      },
    ]);
    const out = await scoreCandidate(ai, candidate, profile);
    expect(out.extraction.score).toBe(80);
    expect(out.neurons).toBe(210);
    expect(out.retried).toBe(false);
  });

  it("retries once with strict prompt on malformed first response, then succeeds", async () => {
    const ai = aiReturning([
      { response: "I cannot comply." } as AiResponse, // no tool_calls
      {
        tool_calls: [
          {
            function: { name: "extract_mission", arguments: JSON.stringify(goodArgs) },
          },
        ],
        usage: { neurons: 180 },
      },
    ]);
    const out = await scoreCandidate(ai, candidate, profile);
    expect(out.extraction.score).toBe(80);
    expect(out.retried).toBe(true);
    const calls = (ai.run as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(2);
    // Second call must use the strict-prompt variant so the model gets the
    // stronger "tool-call only, no prose" reinforcement on retry.
    const secondCallMessages = calls[1][1].messages;
    expect(secondCallMessages[0].content).toContain(STRICT_RETRY_NOTE);
  });

  it("falls back to the configured guess when usage.neurons is absent", async () => {
    const ai = aiReturning([
      {
        tool_calls: [
          {
            function: { name: "extract_mission", arguments: JSON.stringify(goodArgs) },
          },
        ],
        // no usage field
      } as AiResponse,
    ]);
    const out = await scoreCandidate(ai, candidate, profile);
    expect(out.neurons).toBeGreaterThan(0); // the guess kicks in
  });

  it("throws ScoringFailedError after persistent malformed responses", async () => {
    const ai = aiReturning([
      { response: "nope" } as AiResponse,
      { response: "still nope" } as AiResponse,
    ]);
    await expect(scoreCandidate(ai, candidate, profile)).rejects.toMatchObject({
      name: "ScoringFailedError",
    });
  });

  it("counts neurons across BOTH calls when a retry happens", async () => {
    const ai = aiReturning([
      { response: "bad", usage: { neurons: 50 } } as AiResponse,
      {
        tool_calls: [
          {
            function: { name: "extract_mission", arguments: JSON.stringify(goodArgs) },
          },
        ],
        usage: { neurons: 200 },
      },
    ]);
    const out = await scoreCandidate(ai, candidate, profile);
    expect(out.neurons).toBe(250);
  });
});
