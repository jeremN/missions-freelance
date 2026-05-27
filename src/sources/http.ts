import type { FetchResult } from "./types";

const USER_AGENT =
  "missions-free/0.1 (+https://github.com/; personal freelance-mission radar)";

export interface FetchJsonDeps {
  fetchImpl?: typeof fetch;
  baseDelayMs?: number;
  maxRetries?: number;
}

export type FetchJson = <T>(
  url: string,
  opts?: { etag?: string | null; lastModified?: string | null },
) => Promise<FetchResult<T>>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Cap any single backoff so a hostile/misconfigured upstream can't stall the
// whole tick — Workers have wall-clock limits and we round-robin many sources.
const MAX_RETRY_DELAY_MS = 20_000;

/** Build a conditional, rate-limit-respecting JSON fetcher. */
export function createFetchJson(deps: FetchJsonDeps = {}): FetchJson {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const baseDelayMs = deps.baseDelayMs ?? 800;
  const maxRetries = deps.maxRetries ?? 3;

  return async function fetchJson<T>(url, opts = {}) {
    const headers: Record<string, string> = {
      "User-Agent": USER_AGENT,
      Accept: "application/json",
    };
    if (opts.etag != null) headers["If-None-Match"] = opts.etag;
    if (opts.lastModified != null) headers["If-Modified-Since"] = opts.lastModified;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const res = await fetchImpl(url, { headers });

      if (res.status === 304) {
        return { data: null, notModified: true };
      }
      if (res.ok) {
        const data = (await res.json()) as T;
        return {
          data,
          etag: res.headers.get("etag") ?? undefined,
          lastModified: res.headers.get("last-modified") ?? undefined,
          notModified: false,
        };
      }

      // 403 is treated as retryable because some APIs (e.g. Reddit) return it
      // transiently under throttling, not just for true authorization failures.
      const retryable = res.status === 429 || res.status === 403 || res.status >= 500;
      if (!retryable || attempt === maxRetries) {
        throw new Error(`fetch ${url} failed: HTTP ${res.status}`);
      }

      // Retry-After is in seconds; fall back to exponential backoff otherwise.
      const retryAfter = Number(res.headers.get("retry-after"));
      const rawDelay = Number.isFinite(retryAfter)
        ? retryAfter * 1000
        : baseDelayMs * 2 ** attempt;
      await sleep(Math.min(Math.max(0, rawDelay), MAX_RETRY_DELAY_MS));
    }
    // Unreachable, but satisfies the type checker.
    throw new Error(`fetch ${url} failed: retries exhausted`);
  };
}
