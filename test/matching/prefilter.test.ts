import { describe, expect, it } from "vitest";
import { prefilter } from "../../src/matching/prefilter";
import type { RawMission } from "../../src/sources/types";
import { profile as deployedProfile } from "../../src/config";

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

  it("matches a skill token as the prefix of a longer word (react → reactjs)", () => {
    const r = prefilter(mission({ title: "Senior ReactJS engineer" }), profile);
    expect(r.passed).toBe(true);
  });

  it("does not match a short skill token mid-word (ia inside social/média)", () => {
    const p = { ...profile, skills: ["ia"] };
    const r = prefilter(
      mission({ title: "Animateur réseau social", body: "média et communication" }),
      p,
    );
    expect(r.passed).toBe(false);
    expect(r.reasons).toContain("no-skill-match");
  });

  it("matches a short skill token as a standalone word (IA)", () => {
    const p = { ...profile, skills: ["ia"] };
    const r = prefilter(mission({ title: "Développeur IA / LLM" }), p);
    expect(r.passed).toBe(true);
  });
});

describe("prefilter with the deployed profile", () => {
  const m = (over: Partial<RawMission>): RawMission => ({
    source: "codeur",
    externalId: "x",
    url: "https://x",
    title: "",
    body: "",
    ...over,
  });

  it("passes a full-stack / Next.js posting", () => {
    expect(prefilter(m({ title: "Développeur Full-Stack (Next.js)" }), deployedProfile).passed).toBe(true);
  });

  it("passes an AI posting via the ia/llm terms", () => {
    expect(
      prefilter(m({ title: "Ingénieur IA générative", body: "RAG, LLM, embeddings" }), deployedProfile).passed,
    ).toBe(true);
  });

  it("rejects an unrelated posting", () => {
    expect(prefilter(m({ title: "Plombier chauffagiste" }), deployedProfile).passed).toBe(false);
  });
});
