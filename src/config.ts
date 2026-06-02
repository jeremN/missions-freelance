import type { PrefilterProfile } from "./matching/prefilter";

/** The user's editable profile — single source of truth for the pre-filter. */
export type Profile = PrefilterProfile;

export const profile: Profile = {
  skills: ["typescript", "react", "svelte", "node", "cloudflare", "javascript"],
  hardKill: ["cdi", "stage", "alternance", "apprentissage", "for hire"],
  tjm: { lowballBelow: 450 },
};

// ----- M2a (AI scoring) -----------------------------------------------------

export const AI_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

/** Cloudflare Workers AI free allocation per UTC day. */
export const DAILY_NEURON_BUDGET = 10_000;

/**
 * Per-call neuron estimate used ONLY to size each tick's batch up-front
 * (`batchSize = min(MAX_BATCH, floor(budget / guess))`). A deliberately
 * conservative placeholder for the 70B model — large enough that one tick can't
 * blow the daily budget — pending the real `usage.neurons` observed in prod, at
 * which point this constant should be tuned to match. Actual spend is tracked
 * post-call from `usage.neurons` and feeds the NEXT tick's budget; it does not
 * resize the current tick.
 */
export const NEURONS_PER_CALL_GUESS = 1500;

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

// ----- M3 (digest email) ----------------------------------------------------

/**
 * Daily digest size: the email carries the top-N un-notified real missions ranked
 * by score (no absolute threshold). Un-selected missions compete the next day.
 */
export const DIGEST_TOP_N = 5;
