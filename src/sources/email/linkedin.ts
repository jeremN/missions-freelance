import type { RawMission } from "../types";
import type { EmailParser, ParsedEmail } from "./types";

// Stable signal in LinkedIn job-alert emails: job-view URLs carrying the numeric
// job id. The plain-text part is far more stable than the CSS-heavy HTML.
const JOB_URL = /https?:\/\/(?:www\.)?linkedin\.com\/(?:comm\/)?jobs\/view\/(\d+)/gi;

const MAX_CONTEXT_LINES = 3;

function parseLinkedIn(email: ParsedEmail): RawMission[] {
  const text = email.text && email.text.trim().length > 0 ? email.text : email.html ?? "";
  if (!text) return [];

  const out: RawMission[] = [];
  const seen = new Set<string>();
  let context: string[] = []; // recent non-URL text lines preceding a job link

  for (const line of text.split(/\r?\n/)) {
    JOB_URL.lastIndex = 0;
    const ids = [...line.matchAll(JOB_URL)].map((m) => m[1]);

    if (ids.length === 0) {
      const t = line.trim();
      // Keep short human text lines as context; skip blank lines and bare URLs.
      if (t && !/^https?:\/\//i.test(t)) {
        context.push(t);
        if (context.length > MAX_CONTEXT_LINES) context.shift();
      }
      continue;
    }

    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({
        source: "linkedin",
        externalId: id,
        url: `https://www.linkedin.com/jobs/view/${id}`,
        title: context[0] ?? `LinkedIn job ${id}`,
        body: context.join(" · "),
      });
    }
    context = []; // reset so the next job's title doesn't inherit this one's lines
  }

  return out;
}

export const linkedInEmailParser: EmailParser = {
  id: "linkedin",
  senderDomains: ["linkedin.com"],
  parse: parseLinkedIn,
};
