import type { PrefilterProfile } from "./matching/prefilter";

/** The user's editable profile — single source of truth for the pre-filter. */
export type Profile = PrefilterProfile;

export const profile: Profile = {
  skills: [
    "typescript",
    "react",
    "svelte",
    "sveltekit",
    "node",
    "cloudflare",
    "javascript",
    "fullstack",
    "full-stack",
    "frontend",
    "front-end",
    "nextjs",
    "next.js",
    "nuxt",
    "backend",
    "back-end",
    "remix",
    "astro",
    "ia",
    "llm",
    "genai",
    "intelligence artificielle",
  ],
  hardKill: ["cdi", "stage", "alternance", "apprentissage", "for hire"],
  tjm: { lowballBelow: 450 },
};

// ----- M2a (AI scoring) -----------------------------------------------------

export const AI_MODEL = "@cf/google/gemma-4-26b-a4b-it";

/** Cloudflare Workers AI free allocation per UTC day. */
export const DAILY_NEURON_BUDGET = 10_000;

/**
 * Per-call neuron estimate used ONLY to size each tick's batch up-front
 * (`batchSize = min(MAX_BATCH, floor(budget / guess))`) and to attribute a flat
 * cost when the binding does not report `usage.neurons`. Grounded in the Workers
 * AI pricing table: a ~2k-input / ~150-output scoring call is ~10-65 neurons
 * depending on the model (Gemma 4 A4B ≈ 22), so 50 is a realistic, slightly
 * conservative figure. (It was previously 1500 — a ~30x over-estimate that
 * silently throttled throughput to a few candidates per day.)
 */
export const NEURONS_PER_CALL_GUESS = 50;

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

/**
 * Daily digest link validation. The digest over-selects this many un-notified
 * candidates so that broken links can be dropped and backfilled while still
 * shipping a full DIGEST_TOP_N of working links. Kept at 4× the digest size so
 * the buffer scales automatically if DIGEST_TOP_N changes.
 */
export const DIGEST_VALIDATION_POOL = 4 * DIGEST_TOP_N;

/**
 * Consecutive failed link validations before a mission is retired (marked
 * notified) so it stops occupying a pool slot and being re-checked daily.
 */
export const DIGEST_GIVE_UP_AFTER = 3;

/**
 * Per-link validation timeout (HEAD/GET), in milliseconds. A Worker subrequest
 * inherits a generous cap; 5s keeps the (up to DIGEST_VALIDATION_POOL) concurrent
 * checks well inside the digest tick's budget while tolerating slow job boards.
 */
export const LINK_CHECK_TIMEOUT_MS = 5000;
