import { describe, expect, it } from "vitest";
import {
  EXTRACTION_TOOL,
  parseExtraction,
  type Extraction,
} from "../../src/scoring/schema";

describe("EXTRACTION_TOOL", () => {
  it("declares a function tool named extract_mission with required fields", () => {
    expect(EXTRACTION_TOOL.type).toBe("function");
    expect(EXTRACTION_TOOL.function.name).toBe("extract_mission");
    const req = EXTRACTION_TOOL.function.parameters.required;
    for (const k of ["is_real_mission", "remote", "client_type", "score", "reason"]) {
      expect(req).toContain(k);
    }
  });
});

describe("parseExtraction", () => {
  it("accepts a fully-populated valid payload", () => {
    const payload: Extraction = {
      is_real_mission: true,
      rate_eur_per_day: 600,
      duration: "6 mois",
      remote: "full",
      location: "Paris",
      skills: ["react", "typescript"],
      client_type: "direct",
      score: 82,
      reason: "Stack match, full-remote, rate in range.",
    };
    expect(parseExtraction(payload)).toEqual(payload);
  });

  it("fills sensible defaults for nullable / optional fields", () => {
    const payload = {
      is_real_mission: false,
      remote: "unknown",
      client_type: "unknown",
      score: 0,
      reason: "Not a freelance mission.",
    };
    const out = parseExtraction(payload);
    expect(out.rate_eur_per_day).toBeNull();
    expect(out.duration).toBeNull();
    expect(out.location).toBeNull();
    expect(out.skills).toEqual([]);
  });

  it("throws on missing required field", () => {
    expect(() =>
      parseExtraction({ is_real_mission: true, remote: "full", score: 50 }),
    ).toThrow(/required/i);
  });

  it("throws on out-of-range score", () => {
    expect(() =>
      parseExtraction({
        is_real_mission: true,
        remote: "full",
        client_type: "direct",
        score: 150,
        reason: "ok",
      }),
    ).toThrow(/score/);
  });

  it("throws on invalid enum value", () => {
    expect(() =>
      parseExtraction({
        is_real_mission: true,
        remote: "remote",
        client_type: "direct",
        score: 50,
        reason: "ok",
      }),
    ).toThrow(/remote/);
  });

  it("throws on non-integer rate_eur_per_day (schema promises integer)", () => {
    expect(() =>
      parseExtraction({
        is_real_mission: true,
        remote: "full",
        client_type: "direct",
        score: 50,
        reason: "ok",
        rate_eur_per_day: 600.5,
      }),
    ).toThrow(/rate_eur_per_day/);
  });
});
