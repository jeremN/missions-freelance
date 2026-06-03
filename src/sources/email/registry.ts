import type { EmailParser } from "./types";
import { linkedInEmailParser } from "./linkedin";

const PARSERS: EmailParser[] = [linkedInEmailParser];

/** Domain portion of an email address, lowercased; null if not an address. */
function domainOf(from: string): string | null {
  const at = from.lastIndexOf("@");
  if (at === -1 || at === from.length - 1) return null;
  return from.slice(at + 1).trim().toLowerCase();
}

/** Find the parser whose allow-list covers this sender's domain, else null. */
export function parserForSender(from: string): EmailParser | null {
  const domain = domainOf(from);
  if (!domain) return null;
  return (
    PARSERS.find((p) =>
      p.senderDomains.some((d) => domain === d || domain.endsWith(`.${d}`)),
    ) ?? null
  );
}
