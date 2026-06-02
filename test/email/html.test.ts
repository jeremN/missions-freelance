import { describe, expect, it } from "vitest";
import { escapeHtml, safeUrl } from "../../src/email/html";

describe("email/html", () => {
  it("escapes the five HTML-significant characters", () => {
    expect(escapeHtml(`<b>"x" & 'y'</b>`)).toBe(
      "&lt;b&gt;&quot;x&quot; &amp; &#39;y&#39;&lt;/b&gt;",
    );
  });

  it("passes through http(s) URLs and blocks dangerous schemes", () => {
    expect(safeUrl("https://example.com/x")).toBe("https://example.com/x");
    expect(safeUrl("http://example.com")).toBe("http://example.com");
    expect(safeUrl("javascript:alert(1)")).toBe("#");
    expect(safeUrl("data:text/html,x")).toBe("#");
  });

  it("safeUrl returns '#' for non-string input crossing the runtime boundary", () => {
    expect(safeUrl(null)).toBe("#");
    expect(safeUrl(undefined)).toBe("#");
    expect(safeUrl(42)).toBe("#");
  });
});
