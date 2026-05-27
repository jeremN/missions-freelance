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
    if (opts.etag) headers["If-None-Match"] = opts.etag;
    if (opts.lastModified) headers["If-Modified-Since"] = opts.lastModified;

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

      const retryable = res.status === 429 || res.status === 403 || res.status >= 500;
      if (!retryable || attempt === maxRetries) {
        throw new Error(`fetch ${url} failed: HTTP ${res.status}`);
      }

      const retryAfter = Number(res.headers.get("retry-after"));
      const delay = Number.isFinite(retryAfter)
        ? retryAfter * 1000
        : baseDelayMs * 2 ** attempt;
      await sleep(delay);
    }
    // Unreachable, but satisfies the type checker.
    throw new Error(`fetch ${url} failed: retries exhausted`);
  };
}
