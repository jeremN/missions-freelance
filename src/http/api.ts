import type { Env } from "../types/env";
import { getCandidates, getStats } from "../store/db";

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

/**
 * Handle /api/* routes. Returns null for non-API paths so the caller can
 * fall through to static assets.
 */
export async function handleApi(
  request: Request,
  env: Env,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/")) return null;

  switch (url.pathname) {
    case "/api/candidates": {
      const limit = Number(url.searchParams.get("limit") ?? 100);
      const candidates = await getCandidates(env.DB, { limit });
      return json({ candidates });
    }
    case "/api/stats": {
      return json(await getStats(env.DB));
    }
    default:
      return json({ error: "not_found" }, 404);
  }
}
