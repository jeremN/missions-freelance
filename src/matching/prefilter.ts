import type { RawMission } from "../sources/types";

export interface PrefilterProfile {
  skills: string[];
  hardKill: string[];
  tjm: { lowballBelow: number };
}

export interface PrefilterResult {
  passed: boolean;
  reasons: string[];
  tjm: number | null;
  /**
   * True when TJM was extracted and is below the configured threshold.
   * Does NOT affect `passed` — lowball-rated posts still flow through so the
   * downstream AI scoring can decide. Use `lowball` to deprioritize, not drop.
   */
  lowball: boolean;
}

/** Lowercase + strip diacritics so "Développeur" matches "developpeur". */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

// Static regex literal — trivially ReDoS-safe (single-char input).
const WORD_CHAR = /\w/;

/**
 * Word-boundary substring check, implemented without dynamic regex:
 * finds `term` in `haystack` only where it sits between non-word characters
 * (or string edges). Avoids killing "stage" inside "backstage" / "staging"
 * without ever constructing a RegExp from user/config-supplied input.
 */
function containsAsWord(haystack: string, term: string): boolean {
  if (term.length === 0) return false;
  for (let idx = haystack.indexOf(term); idx !== -1; idx = haystack.indexOf(term, idx + 1)) {
    const before = idx > 0 ? haystack[idx - 1] : "";
    const after =
      idx + term.length < haystack.length ? haystack[idx + term.length] : "";
    const leftOk = before === "" || !WORD_CHAR.test(before);
    const rightOk = after === "" || !WORD_CHAR.test(after);
    if (leftOk && rightOk) return true;
  }
  return false;
}

/**
 * True if `term` occurs in `haystack` starting at a word boundary (the preceding
 * char is a non-word char or the string start). The right side is unrestricted, so
 * a skill token also matches its common concatenations: "react" → "reactjs",
 * "svelte" → "sveltekit", "node" → "node.js". Unlike a raw substring check this
 * stops short tokens from matching mid-word ("ia" inside "social"/"média").
 * No dynamic RegExp — ReDoS-safe, like `containsAsWord`.
 */
function matchesSkillTerm(haystack: string, term: string): boolean {
  if (term.length === 0) return false;
  for (let idx = haystack.indexOf(term); idx !== -1; idx = haystack.indexOf(term, idx + 1)) {
    const before = idx > 0 ? haystack[idx - 1] : "";
    if (before === "" || !WORD_CHAR.test(before)) return true;
  }
  return false;
}

/**
 * Find the first day-rate figure in EUR, if any.
 * Currency is REQUIRED — bare numbers like "TJM 600" without €/EUR/euro(s)
 * are ignored on purpose, otherwise years, postal codes, and ticket counts
 * would generate false positives.
 * Matches: "600€/j", "600 EUR/jour", "TJM: 600 EUR", "350€/jour".
 */
function extractTjm(text: string): number | null {
  const re =
    /(?:tjm\s*:?\s*)?\b(\d{2,4})\b\s*(?:€|eur|euros?)\s*(?:\/?\s*(?:j|jour|jr|day|d))?/i;
  const m = text.match(re);
  return m ? Number(m[1]) : null;
}

export function prefilter(
  m: RawMission,
  profile: PrefilterProfile,
): PrefilterResult {
  const haystack = normalize(`${m.title}\n${m.body}`);
  const reasons: string[] = [];

  for (const term of profile.hardKill) {
    if (containsAsWord(haystack, normalize(term))) reasons.push(`hard-kill:${term}`);
  }

  const matchedSkill = profile.skills.some((s) => matchesSkillTerm(haystack, normalize(s)));
  if (!matchedSkill) reasons.push("no-skill-match");

  const tjm = extractTjm(`${m.title} ${m.body}`);
  const lowball = tjm !== null && tjm < profile.tjm.lowballBelow;

  return { passed: reasons.length === 0, reasons, tjm, lowball };
}
