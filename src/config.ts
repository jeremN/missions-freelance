export interface Profile {
  skills: string[];
  hardKill: string[];
  tjm: { lowballBelow: number };
}

export const profile: Profile = {
  skills: ["typescript", "react", "svelte", "node", "cloudflare", "javascript"],
  hardKill: ["cdi", "stage", "alternance", "apprentissage", "for hire"],
  tjm: { lowballBelow: 450 },
};
