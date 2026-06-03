import { describe, expect, it } from "vitest";
import { linkedInEmailParser } from "../../../src/sources/email/linkedin";
import { parserForSender } from "../../../src/sources/email/registry";

const TEXT = [
  "Senior React Engineer",
  "Acme · Paris, France (Remote)",
  "https://www.linkedin.com/comm/jobs/view/3812345678/?trk=eml-jobs_alert",
  "",
  "Lead TypeScript Developer",
  "Globex · Lyon",
  "https://www.linkedin.com/comm/jobs/view/3812345679/?trk=eml-jobs_alert",
  "",
  "You are receiving Job alerts emails.",
  "Unsubscribe: https://www.linkedin.com/comm/psettings/email-unsubscribe",
].join("\n");

describe("linkedInEmailParser", () => {
  it("extracts one mission per job-view URL with id, canonical url and title", () => {
    const out = linkedInEmailParser.parse({ text: TEXT });
    expect(out).toHaveLength(2);

    expect(out[0]).toMatchObject({
      source: "linkedin",
      externalId: "3812345678",
      url: "https://www.linkedin.com/jobs/view/3812345678",
      title: "Senior React Engineer",
    });
    expect(out[0].body).toContain("Acme");
    expect(out[1].externalId).toBe("3812345679");
    expect(out[1].title).toBe("Lead TypeScript Developer");
  });

  it("ignores non-job LinkedIn links (unsubscribe/settings)", () => {
    const out = linkedInEmailParser.parse({
      text: "Unsubscribe: https://www.linkedin.com/comm/psettings/email-unsubscribe",
    });
    expect(out).toEqual([]);
  });

  it("dedups a job id repeated within one email", () => {
    const dup = [
      "Role A",
      "https://www.linkedin.com/comm/jobs/view/111/?x=1",
      "Role A (again)",
      "https://www.linkedin.com/jobs/view/111",
    ].join("\n");
    const out = linkedInEmailParser.parse({ text: dup });
    expect(out).toHaveLength(1);
    expect(out[0].externalId).toBe("111");
  });

  it("returns [] for empty text", () => {
    expect(linkedInEmailParser.parse({ text: "" })).toEqual([]);
    expect(linkedInEmailParser.parse({})).toEqual([]);
  });

  it("falls back to the html part when the text part is empty", () => {
    const out = linkedInEmailParser.parse({
      text: "",
      html: "Senior Role\nhttps://www.linkedin.com/comm/jobs/view/222/?x=1",
    });
    expect(out).toHaveLength(1);
    expect(out[0].externalId).toBe("222");
    expect(out[0].url).toBe("https://www.linkedin.com/jobs/view/222");
  });
});

describe("parserForSender", () => {
  it("routes linkedin.com senders to the LinkedIn parser", () => {
    expect(parserForSender("jobalerts-noreply@linkedin.com")?.id).toBe("linkedin");
    expect(parserForSender("JOBALERTS@LinkedIn.com")?.id).toBe("linkedin");
  });
  it("returns null for unknown senders", () => {
    expect(parserForSender("noreply@evil.com")).toBeNull();
    expect(parserForSender("garbage")).toBeNull();
  });
  it("rejects look-alike sender domains (spoof tricks)", () => {
    expect(parserForSender("noreply@linkedin.com.evil.com")).toBeNull();
    expect(parserForSender("linkedin.com@evil.com")).toBeNull();
    expect(parserForSender("noreply@notlinkedin.com")).toBeNull();
  });
});
