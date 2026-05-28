import { describe, expect, it } from "vitest";
import { prefilter } from "../../src/matching/prefilter";
import type { RawMission } from "../../src/sources/types";

const profile = {
  skills: ["react", "typescript"],
  hardKill: ["cdi", "alternance", "stage"],
  tjm: { lowballBelow: 450 },
};

const mission = (over: Partial<RawMission>): RawMission => ({
  source: "reddit",
  externalId: "x",
  url: "https://x",
  title: "",
  body: "",
  ...over,
});

describe("prefilter", () => {
  it("passes a post matching a skill", () => {
    const r = prefilter(mission({ title: "Senior React developer needed" }), profile);
    expect(r.passed).toBe(true);
  });

  it("rejects when no skill matches", () => {
    const r = prefilter(mission({ title: "COBOL mainframe specialist" }), profile);
    expect(r.passed).toBe(false);
    expect(r.reasons).toContain("no-skill-match");
  });

  it("rejects on a hard-kill term even if a skill matches", () => {
    const r = prefilter(
      mission({ title: "React developer", body: "Poste en CDI à Lyon" }),
      profile,
    );
    expect(r.passed).toBe(false);
    expect(r.reasons).toContain("hard-kill:cdi");
  });

  it("is accent- and case-insensitive", () => {
    const r = prefilter(mission({ title: "Développeur REACT (typescript)" }), profile);
    expect(r.passed).toBe(true);
  });

  it("extracts TJM and flags lowball", () => {
    const r = prefilter(
      mission({ title: "React mission", body: "Budget: 350€/jour" }),
      profile,
    );
    expect(r.tjm).toBe(350);
    expect(r.lowball).toBe(true);
  });

  it("extracts TJM without lowball flag when above threshold", () => {
    const r = prefilter(
      mission({ title: "React mission", body: "TJM 600 EUR" }),
      profile,
    );
    expect(r.tjm).toBe(600);
    expect(r.lowball).toBe(false);
  });

  it("does not extract TJM when the currency is absent", () => {
    // Bare numbers without €/EUR are intentionally ignored to avoid false
    // positives on years, postal codes, ticket counts, etc.
    const r = prefilter(
      mission({ title: "React mission", body: "TJM 600 / 6 mois" }),
      profile,
    );
    expect(r.tjm).toBeNull();
  });

  it("does not hard-kill 'backstage' or 'staging' via the 'stage' term", () => {
    const r = prefilter(
      mission({
        title: "Senior React engineer",
        body: "Build the Backstage developer portal in staging.",
      }),
      profile,
    );
    expect(r.passed).toBe(true);
    expect(r.reasons.find((s) => s.startsWith("hard-kill:"))).toBeUndefined();
  });

  it("hard-kills 'stage' as a standalone word", () => {
    const r = prefilter(
      mission({
        title: "Stage de fin d'études",
        body: "Mission React de 6 mois pour stagiaire.",
      }),
      profile,
    );
    expect(r.passed).toBe(false);
    expect(r.reasons).toContain("hard-kill:stage");
  });

  it("accumulates both a hard-kill and no-skill-match reason", () => {
    const r = prefilter(
      mission({ title: "COBOL specialist", body: "Poste en CDI à Paris" }),
      profile,
    );
    expect(r.passed).toBe(false);
    expect(r.reasons).toEqual(
      expect.arrayContaining(["hard-kill:cdi", "no-skill-match"]),
    );
  });
});
