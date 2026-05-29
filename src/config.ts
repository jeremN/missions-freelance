import type { PrefilterProfile } from "./matching/prefilter";

/** The user's editable profile — single source of truth for the pre-filter. */
export type Profile = PrefilterProfile;

export const profile: Profile = {
  skills: ["typescript", "react", "svelte", "node", "cloudflare", "javascript"],
  hardKill: ["cdi", "stage", "alternance", "apprentissage", "for hire"],
  tjm: { lowballBelow: 450 },
};

// ----- M2a (AI scoring) -----------------------------------------------------

export const AI_MODEL = "@cf/meta/llama-3.1-8b-instruct";

/** Cloudflare Workers AI free allocation per UTC day. */
export const DAILY_NEURON_BUDGET = 10_000;

/** Conservative per-call estimate used to size each tick's batch. */
export const NEURONS_PER_CALL_GUESS = 200;

/** Hard cap on AI calls per score-tick invocation (keeps subrequests safely < 50). */
export const MAX_BATCH = 8;

/** A more focused profile slice passed to the LLM as task context. */
export interface ScoringProfile {
  skills: string[];
  seniority: string;
  tjm: { min: number; max: number; lowballBelow: number };
  remotePreference: "remote-first" | "onsite-ok-paris" | "any";
  killClientTypes: Array<"esn" | "agency">;
  minDurationMonths: number;
}

export const scoringProfile: ScoringProfile = {
  skills: profile.skills,
  seniority: "senior",
  tjm: { min: 500, max: 700, lowballBelow: profile.tjm.lowballBelow },
  remotePreference: "remote-first",
  killClientTypes: [],
  minDurationMonths: 3,
};
