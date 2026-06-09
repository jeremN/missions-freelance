import { describe, expect, it } from "vitest";
import { renderDigest } from "../../src/email/digest";
import type { MissionRow } from "../../src/store/missions";

const NOW = new Date("2026-06-01T05:00:00.000Z");

function mission(over: Partial<MissionRow> = {}): MissionRow {
  return {
    id: 1,
    candidateId: 1,
    source: "free-work",
    url: "https://example.com/m/1",
    title: "Senior React mission",
    isRealMission: true,
    rateEurDay: 600,
    duration: "6 mois",
    remote: "full",
    location: null,
    skills: ["react"],
    clientType: "direct",
    score: 80,
    reason: "Stack match, remote, day-rate in range.",
    rawResponse: "{}",
    firstSeen: "2026-06-01T00:00:00.000Z",
    lastSeen: "2026-06-01T00:00:00.000Z",
    notified: false,
    validationFails: 0,
    ...over,
  };
}

describe("renderDigest", () => {
  it("subject reflects the count and the top score", () => {
    const { subject } = renderDigest(
      [mission({ id: 1, score: 92 }), mission({ id: 2, score: 71 })],
      { now: NOW },
    );
    expect(subject).toBe("missions-free — 2 new (top 92)");
  });

  it("html contains each mission's title, score, and link", () => {
    const { html, text } = renderDigest([mission({ score: 88 })], {
      now: NOW,
    });
    expect(html).toContain("Senior React mission");
    expect(html).toContain("[88]");
    expect(html).toContain('href="https://example.com/m/1"');
    expect(html).toContain("600€/j"); // meta line: rate
    expect(html).toContain("full"); // meta line: remote
    expect(text).toContain("Senior React mission");
    expect(text).toContain("600€/j");
    expect(text).toContain("https://example.com/m/1");
  });

  it("handles an empty selection without crashing", () => {
    const { subject, html, text } = renderDigest([], { now: NOW });
    expect(subject).toBe("missions-free — nothing new");
    expect(html).toContain("No new missions");
    expect(text).toContain("No new missions");
  });

  it("escapes HTML in scraped fields and blocks dangerous link schemes", () => {
    const { html } = renderDigest(
      [
        mission({
          title: "<script>alert(1)</script>",
          url: "javascript:alert(1)",
          reason: 'a & b "c"',
        }),
      ],
      { now: NOW },
    );
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain('href="#"');
    expect(html).toContain("a &amp; b &quot;c&quot;");
  });
});
