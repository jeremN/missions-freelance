import type { Env } from "../types/env";
import { getCandidates, getRecentRuns, getStats } from "../store/db";
import { getMissions } from "../store/missions";

const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 100;

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      // Personal dashboard data — never cache at the edge.
      "cache-control": "private, no-store",
    },
  });

/** Parse and clamp ?limit — invalid/negative values fall back to the default. */
function parseLimit(raw: string | null): number {
  const n = raw === null ? DEFAULT_LIMIT : Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.min(n, MAX_LIMIT) : DEFAULT_LIMIT;
}

/**
 * Handle /api/* routes. Returns null for non-API paths so the caller can
 * fall through to static assets. Every API response is JSON, including errors.
 */
export async function handleApi(
  request: Request,
  env: Env,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/")) return null;

  if (request.method !== "GET") {
    return json({ error: "method_not_allowed" }, 405);
  }

  try {
    switch (url.pathname) {
      case "/api/candidates": {
        const limit = parseLimit(url.searchParams.get("limit"));
        const candidates = await getCandidates(env.DB, { limit });
        return json({ candidates });
      }
      case "/api/stats":
        return json(await getStats(env.DB));
      case "/api/runs": {
        const limit = parseLimit(url.searchParams.get("limit"));
        const runs = await getRecentRuns(env.DB, limit);
        return json({ runs });
      }
      case "/api/missions": {
        const limit = parseLimit(url.searchParams.get("limit"));
        const minScore = Number(url.searchParams.get("minScore") ?? 0);
        const safeMinScore =
          Number.isFinite(minScore) && minScore >= 0 ? Math.min(minScore, 100) : 0;
        const missions = await getMissions(env.DB, { limit, minScore: safeMinScore });
        return json({ missions });
      }
      default:
        return json({ error: "not_found" }, 404);
    }
  } catch (err) {
    // JSON.stringify neutralizes any control chars (e.g. percent-decoded
    // newlines) in the request path, preventing log-line forgery (CWE-117).
    console.error("api failed:", JSON.stringify(url.pathname), err);
    return json({ error: "internal" }, 500);
  }
}
