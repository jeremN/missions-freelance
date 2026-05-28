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
  lowball: boolean;
}

/** Lowercase + strip diacritics so "Développeur" matches "developpeur". */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

/** Find the first day-rate figure in EUR, if any. */
function extractTjm(text: string): number | null {
  // Matches "600€/j", "600 EUR/jour", "TJM 600", "350€/jour".
  const re = /(?:tjm\s*:?\s*)?(\d{2,4})\s*(?:€|eur|euros?)\s*(?:\/?\s*(?:j|jour|jr|day|d))?/i;
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
    if (haystack.includes(normalize(term))) reasons.push(`hard-kill:${term}`);
  }

  const matchedSkill = profile.skills.some((s) => haystack.includes(normalize(s)));
  if (!matchedSkill) reasons.push("no-skill-match");

  const tjm = extractTjm(`${m.title} ${m.body}`);
  const lowball = tjm !== null && tjm < profile.tjm.lowballBelow;

  return { passed: reasons.length === 0, reasons, tjm, lowball };
}
