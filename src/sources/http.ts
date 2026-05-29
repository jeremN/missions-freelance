import type { FetchResult } from "./types";

const USER_AGENT =
  "missions-free/0.1 (+https://github.com/; personal freelance-mission radar)";

// Cap any single backoff so a hostile/misconfigured upstream can't stall the
// whole tick — Workers have wall-clock limits and we round-robin many sources.
const MAX_RETRY_DELAY_MS = 20_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface FetchClientsDeps {
  fetchImpl?: typeof fetch;
  baseDelayMs?: number;
  maxRetries?: number;
}

export type FetchJson = <T>(
  url: string,
  opts?: { etag?: string | null; lastModified?: string | null },
) => Promise<FetchResult<T>>;

export type FetchText = (
  url: string,
  opts?: { etag?: string | null; lastModified?: string | null },
) => Promise<FetchResult<string>>;

export interface FetchClients {
  fetchJson: FetchJson;
  fetchText: FetchText;
}

/** Build a conditional, rate-limit-respecting pair of fetchers. */
export function createFetchClients(deps: FetchClientsDeps = {}): FetchClients {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const baseDelayMs = deps.baseDelayMs ?? 800;
  const maxRetries = deps.maxRetries ?? 3;

  async function withRetry(
    url: string,
    accept: string,
    opts: { etag?: string | null; lastModified?: string | null } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = {
      "User-Agent": USER_AGENT,
      Accept: accept,
    };
    if (opts.etag != null) headers["If-None-Match"] = opts.etag;
    if (opts.lastModified != null)
      headers["If-Modified-Since"] = opts.lastModified;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const res = await fetchImpl(url, { headers });

      if (res.status === 304 || res.ok) return res;

      // 403 is treated as retryable because some APIs (e.g. Reddit) return it
      // transiently under throttling, not just for true authorization failures.
      const retryable =
        res.status === 429 || res.status === 403 || res.status >= 500;
      if (!retryable || attempt === maxRetries) {
        throw new Error(`fetch ${url} failed: HTTP ${res.status}`);
      }

      // Retry-After is in seconds; fall back to exponential backoff otherwise.
      // An empty header value (`""`) also falls through to backoff — `Number("")`
      // would otherwise coerce to 0 (finite) and produce a zero-delay retry.
      const rawHeader = res.headers.get("retry-after");
      const retryAfter = rawHeader ? Number(rawHeader) : NaN;
      const rawDelay = Number.isFinite(retryAfter)
        ? retryAfter * 1000
        : baseDelayMs * 2 ** attempt;
      await sleep(Math.min(Math.max(0, rawDelay), MAX_RETRY_DELAY_MS));
    }
    // Unreachable, but satisfies the type checker.
    throw new Error(`fetch ${url} failed: retries exhausted`);
  }

  const fetchJson: FetchJson = async <T>(url: string, opts = {}) => {
    const res = await withRetry(url, "application/json", opts);
    if (res.status === 304) return { data: null, notModified: true };
    // 204 No Content has an empty body — `res.json()` would throw on it.
    if (res.status === 204) return { data: null, notModified: false };
    const data = (await res.json()) as T;
    return {
      data,
      etag: res.headers.get("etag") ?? undefined,
      lastModified: res.headers.get("last-modified") ?? undefined,
      notModified: false,
    };
  };

  const fetchText: FetchText = async (url, opts = {}) => {
    const res = await withRetry(
      url,
      "text/xml, application/xml, application/atom+xml, application/rss+xml, text/html, */*",
      opts,
    );
    if (res.status === 304) return { data: null, notModified: true };
    // 204 No Content has an empty body — match fetchJson's behavior (return
    // null, not "") so callers can null-check uniformly across both fetchers.
    if (res.status === 204) return { data: null, notModified: false };
    const data = await res.text();
    return {
      data,
      etag: res.headers.get("etag") ?? undefined,
      lastModified: res.headers.get("last-modified") ?? undefined,
      notModified: false,
    };
  };

  return { fetchJson, fetchText };
}
