import type { RawMission } from "../types";

/** Minimal parsed-email shape (decoupled from postal-mime) a parser consumes. */
export interface ParsedEmail {
  subject?: string;
  text?: string;
  html?: string;
}

/** Turns a parsed alert email from one source into raw missions. */
export interface EmailParser {
  /** Becomes RawMission.source, e.g. "linkedin". */
  id: string;
  /** Allow-list of sender domains this parser handles (matched against message.from). */
  senderDomains: string[];
  parse(email: ParsedEmail): RawMission[];
}
