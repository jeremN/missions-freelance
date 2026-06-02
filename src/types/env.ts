export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  AI: Ai;
  /** Resend API key (secret). */
  RESEND_API_KEY: string;
  /** Digest recipient — the owner's inbox (secret, keeps the address out of the public repo). */
  DIGEST_TO: string;
  /** Digest "from" address (secret) — "onboarding@resend.dev" until a domain is verified. */
  DIGEST_FROM: string;
}
