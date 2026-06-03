import { describe, expect, it } from "vitest";
import { selectCandidates } from "../../src/pipeline/select";
import type { RawMission } from "../../src/sources/types";

const profile = {
  skills: ["react", "typescript"],
  hardKill: ["cdi", "stage"],
  tjm: { lowballBelow: 450 },
};

const m = (over: Partial<RawMission>): RawMission => ({
  source: "linkedin",
  externalId: "x",
  url: "https://x",
  title: "",
  body: "",
  ...over,
});

describe("selectCandidates", () => {
  it("keeps skill-matching missions and carries tjm/lowball", () => {
    const out = selectCandidates(
      [m({ externalId: "1", title: "React mission", body: "TJM 300€/jour" })],
      profile,
    );
    expect(out).toHaveLength(1);
    expect(out[0].externalId).toBe("1");
    expect(out[0].tjm).toBe(300);
    expect(out[0].lowball).toBe(true);
  });

  it("drops missions that fail the prefilter (no skill / hard-kill)", () => {
    const out = selectCandidates(
      [
        m({ externalId: "2", title: "COBOL mainframe" }),
        m({ externalId: "3", title: "React dev", body: "Poste en CDI" }),
      ],
      profile,
    );
    expect(out).toEqual([]);
  });
});
