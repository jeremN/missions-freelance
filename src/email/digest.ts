import type { MissionRow } from "../store/missions";
import { escapeHtml, safeUrl } from "./html";

export interface DigestOpts {
  now: Date;
  minScore: number;
}

export interface RenderedDigest {
  subject: string;
  html: string;
  text: string;
}

function rate(m: MissionRow): string {
  return m.rateEurDay != null ? `${m.rateEurDay}€/j` : "—";
}

/** Returns PLAIN TEXT — callers inserting it into HTML must escapeHtml() the result. */
function metaLineText(m: MissionRow): string {
  const loc = m.location ? ` · ${m.location}` : "";
  return `${rate(m)} · ${m.remote} · ${m.source} · ${m.duration || "—"}${loc}`;
}

/** Pure render of the digest email. No I/O. All scraped fields are HTML-escaped. */
export function renderDigest(
  missions: MissionRow[],
  _opts: DigestOpts,
): RenderedDigest {
  if (missions.length === 0) {
    return {
      subject: "missions-free — nothing new",
      html: "<p>No new missions above the threshold.</p>",
      text: "No new missions above the threshold.",
    };
  }

  // reduce (not Math.max(...spread)) so an unbounded array can't hit the
  // argument-count limit — renderDigest itself imposes no cap on its input.
  const top = missions.reduce((max, m) => Math.max(max, m.score), 0);
  const subject = `missions-free — ${missions.length} new (top ${top})`;

  const htmlItems = missions
    .map((m) => {
      const href = escapeHtml(safeUrl(m.url));
      return `  <li>
    <strong>[${escapeHtml(String(m.score))}]</strong>
    <a href="${href}">${escapeHtml(m.title)}</a><br>
    <small>${escapeHtml(metaLineText(m))}</small><br>
    <span>${escapeHtml(m.reason || "")}</span>
  </li>`;
    })
    .join("\n");

  const html = `<h2>${escapeHtml(subject)}</h2>\n<ul>\n${htmlItems}\n</ul>`;

  const textItems = missions
    .map(
      (m) =>
        `[${m.score}] ${m.title}\n  ${metaLineText(m)}\n  ${m.reason || ""}\n  ${m.url}`,
    )
    .join("\n\n");

  const text = `${subject}\n\n${textItems}`;

  return { subject, html, text };
}
