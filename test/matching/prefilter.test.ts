import { describe, expect, it } from "vitest";
import { prefilter } from "../../src/matching/prefilter";
import type { RawMission } from "../../src/sources/types";

const profile = {
  skills: ["react", "typescript"],
  hardKill: ["cdi", "alternance"],
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
});
