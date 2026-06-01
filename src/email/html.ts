const HTML_ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Escape the five HTML-significant characters. Ported from public/app.js. */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => HTML_ENTITIES[ch] ?? ch);
}

/**
 * Allow only http/https URLs; anything else (javascript:, data:, vbscript:, …)
 * collapses to "#". escapeHtml defuses HTML injection but not dangerous URL
 * schemes. Typed `unknown` and guarded at runtime because URLs cross the
 * D1/JSON boundary — a non-string must never reach the regex.
 */
export function safeUrl(u: unknown): string {
  return typeof u === "string" && /^https?:\/\//i.test(u) ? u : "#";
}
