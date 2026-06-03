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
You evaluate freelance mission posts for ONE specific user and extract structured
fields by calling the extract_mission tool. Posts may be in French or English —
handle both. Always respond with a tool call, never prose.

Make TWO INDEPENDENT judgments:

1) is_real_mission (boolean) — TRUE only if this post is a genuine freelance / contract
   MISSION from a hiring party (an end client or an intermediary looking to staff a
   contractor). FALSE for: permanent roles (CDI), internships / apprenticeships
   (stage, alternance, apprentissage), people advertising THEMSELVES ("for hire"),
   agency mass-mailings, or "join our talent pool" posts with no concrete mission.
   Decide this on its own: a real mission that is a poor fit is STILL real.

2) score (0-100) — how well a REAL mission fits the user profile below. For a
   non-mission, set is_real_mission=false and a low score.

USER PROFILE
- Core stack: ${skills}
- Seniority: ${profile.seniority}
- Target day-rate (TJM, EUR): ${profile.tjm.min}-${profile.tjm.max}; below ${profile.tjm.lowballBelow} is lowball.
- Remote preference: ${profile.remotePreference}
- Avoid client types: ${killClients}
- Minimum duration: ${profile.minDurationMonths} months

HOW TO SCORE — rank, don't bucket; produce a spread across 0-100:
- STACK FIT is the dominant factor. If the mission's core technologies fall OUTSIDE the
  user's core stack above (for example a COBOL, pure Java/.NET, ServiceNow, or Salesforce
  mission for someone whose stack is none of those), keep the score LOW (about 0-30) even
  if the rate, remote, or client look attractive.
- When the core stack DOES match, weigh in order: day-rate vs the target range
  (lowball drags it down), remote vs the preference, client type (avoid-list drags it
  down), and duration vs the minimum.
- A strong stack match with in-range rate, preferred remote, and an acceptable client
  belongs near the top (about 75-100). Partial matches land in the middle.

REASON — one line, max 240 chars, citing CONCRETE details from THIS post: name the
actual technologies you saw and the stated rate / remote / client. Never give a
generic verdict.
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
