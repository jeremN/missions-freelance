import type { ScoringProfile } from "../config";

export interface PromptCandidate {
  source: string;
  externalId: string;
  url: string;
  title: string;
  body: string;
}

export interface ChatMessage {
  role: "system" | "user";
  content: string;
}

export interface BuiltPrompt {
  messages: ChatMessage[];
}

export const STRICT_RETRY_NOTE =
  "You MUST call the extract_mission tool. Return ONLY a tool-call, no prose.";

function buildSystemPrompt(profile: ScoringProfile, strict: boolean): string {
  const skills = profile.skills.join(", ");
  const killClients = profile.killClientTypes.length
    ? profile.killClientTypes.join(", ")
    : "none";

  const base = `
You score freelance mission posts for a specific user and extract structured
fields. Always respond by calling the extract_mission tool — never reply with
prose. Input posts may be in French or English; handle both.

USER PROFILE
- Skills: ${skills}
- Seniority: ${profile.seniority}
- Target TJM (EUR/day): min ${profile.tjm.min}, max ${profile.tjm.max}; flag as lowball below ${profile.tjm.lowballBelow}.
- Remote preference: ${profile.remotePreference}
- Disliked client types: ${killClients}
- Minimum acceptable duration: ${profile.minDurationMonths} months

WHAT IS A "REAL MISSION"
- A freelance / contract / mission posting from a hiring party.
- NOT a real mission: CDI / permanent roles, stage / alternance / apprentissage,
  "for hire" self-promo, agency mass-mailings, recycled calls without specifics.

SCORING RUBRIC (0–100)
- 80–100: Stack matches, day-rate in range or above, remote-first or Paris
  on-site, direct client or accepted client type, duration >= ${profile.minDurationMonths} months.
- 50–79: Partial stack match OR rate slightly below range OR hybrid / less
  preferred remote; still actionable.
- 20–49: Mismatch on stack, lowball rate, or disliked client type, but
  ambiguous enough to surface.
- 0–19: Clearly not a fit OR not a real mission.

EXAMPLES
- "[Hiring] Senior React/TS, 6 months, full remote, 600€/j, direct client" → score: 80, reason: "Stack match, in-range TJM, full remote, direct client."
- "Recherche freelance React 2 ans (mais en réalité CDI converti)" → score: 20, reason: "Disguised CDI."
`.trim();

  return strict ? `${base}\n\n${STRICT_RETRY_NOTE}` : base;
}

function buildUserMessage(c: PromptCandidate): string {
  return `Source: ${c.source}\nURL: ${c.url}\nTitle: ${c.title}\n\n---\n${c.body}\n---`;
}

export function buildScoringPrompt(
  c: PromptCandidate,
  profile: ScoringProfile,
  opts: { strict?: boolean } = {},
): BuiltPrompt {
  return {
    messages: [
      { role: "system", content: buildSystemPrompt(profile, opts.strict ?? false) },
      { role: "user", content: buildUserMessage(c) },
    ],
  };
}
