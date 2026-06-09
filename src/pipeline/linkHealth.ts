import { LINK_CHECK_TIMEOUT_MS } from "../config";

export interface LinkCheckResult {
  ok: boolean; // true iff safe to put in the digest
  // HTTP status, or null when no status applies: either a network/timeout error
  // (then ok=false) or an intentionally-skipped allowlisted source (then ok=true).
  // Always read `ok` first to tell those two apart.
  status: number | null;
  redirectedTo?: string; // Location header of a 3xx, for the audit log
}

export interface LinkValidator {
  check(url: string, source: string): Promise<LinkCheckResult>;
}

/**
 * Sources whose links legitimately redirect (auth walls, click tracking) and so
 * can't pass a strict 200-only check — skip validation for these and keep them.
 * LinkedIn job views 3xx to a sign-in wall and behave differently from the
 * Worker's datacenter egress, so a strict check would false-fail every one.
 */
export const SKIP_VALIDATION_SOURCES: ReadonlySet<string> = new Set(["linkedin"]);

export interface LinkValidatorOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  skipSources?: ReadonlySet<string>;
}

export function createLinkValidator(
  opts: LinkValidatorOptions = {},
): LinkValidator {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? LINK_CHECK_TIMEOUT_MS;
  const skipSources = opts.skipSources ?? SKIP_VALIDATION_SOURCES;

  async function probe(url: string, method: "HEAD" | "GET"): Promise<Response> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      // redirect:"manual" so a 3xx surfaces as the 3xx itself (not the followed
      // 200) — that's how the free-work-class soft-404 is caught.
      return await fetchImpl(url, {
        method,
        redirect: "manual",
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async check(url, source) {
      // Source ids are lowercase slugs; lowercase defensively so a stray
      // "LinkedIn" can't slip past the allowlist and hit the network.
      if (skipSources.has(source.toLowerCase())) return { ok: true, status: null };
      try {
        let res = await probe(url, "HEAD");
        if (res.status === 405) res = await probe(url, "GET"); // host rejects HEAD
        if (res.status === 200) return { ok: true, status: 200 };
        if (res.status >= 300 && res.status < 400) {
          return {
            ok: false,
            status: res.status,
            redirectedTo: res.headers.get("location") ?? undefined,
          };
        }
        // Everything else (4xx incl. a GET that also 405s, 5xx) is not-ok.
        return { ok: false, status: res.status };
      } catch {
        return { ok: false, status: null }; // timeout / network — skip today
      }
    },
  };
}
