import type { PrefilterProfile } from "./matching/prefilter";

/** The user's editable profile — single source of truth for the pre-filter. */
export type Profile = PrefilterProfile;

export const profile: Profile = {
  skills: ["typescript", "react", "svelte", "node", "cloudflare", "javascript"],
  hardKill: ["cdi", "stage", "alternance", "apprentissage", "for hire"],
  tjm: { lowballBelow: 450 },
};
