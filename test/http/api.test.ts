import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { handleApi } from "../../src/http/api";
import { insertCandidates, recordRun } from "../../src/store/db";

beforeEach(async () => {
  await env.DB.exec("DELETE FROM candidates");
  await env.DB.exec("DELETE FROM runs");
});

const req = (path: string) => new Request(`https://worker.test${path}`);

describe("handleApi", () => {
  it("returns null for non-API paths (so assets can handle them)", async () => {
    const res = await handleApi(req("/index.html"), env);
    expect(res).toBeNull();
  });

  it("GET /api/candidates returns stored candidates as JSON", async () => {
    await insertCandidates(env.DB, [
      {
        source: "reddit",
        externalId: "a",
        url: "https://x/a",
        title: "React mission",
        body: "",
        tjm: 600,
        lowball: false,
      },
    ]);
    const res = await handleApi(req("/api/candidates"), env);
    expect(res?.status).toBe(200);
    expect(res?.headers.get("content-type")).toContain("application/json");
    const body = (await res!.json()) as { candidates: Array<{ externalId: string }> };
    expect(body.candidates[0].externalId).toBe("a");
  });

  it("GET /api/stats returns counts", async () => {
    await recordRun(env.DB, { tick: "fetch", startedAt: new Date().toISOString() });
    const res = await handleApi(req("/api/stats"), env);
    const body = (await res!.json()) as { totalRuns: number };
    expect(body.totalRuns).toBe(1);
  });

  it("unknown /api/* path returns 404 JSON", async () => {
    const res = await handleApi(req("/api/nope"), env);
    expect(res?.status).toBe(404);
  });

  it("non-GET methods on /api/* return 405", async () => {
    const res = await handleApi(
      new Request("https://worker.test/api/candidates", { method: "POST" }),
      env,
    );
    expect(res?.status).toBe(405);
  });

  it("falls back to default limit when ?limit is non-numeric or negative", async () => {
    await insertCandidates(env.DB, [
      { source: "s", externalId: "a", url: "https://x/a", title: "R", body: "", tjm: null, lowball: false },
      { source: "s", externalId: "b", url: "https://x/b", title: "R", body: "", tjm: null, lowball: false },
      { source: "s", externalId: "c", url: "https://x/c", title: "R", body: "", tjm: null, lowball: false },
    ]);
    // With the old `Number(... ?? 100)` path, `?limit=abc` → NaN → LIMIT NaN → 0 rows.
    const garbage = await handleApi(req("/api/candidates?limit=abc"), env);
    const { candidates: g } = (await garbage!.json()) as { candidates: unknown[] };
    expect(g).toHaveLength(3);
    // And the old path treated `?limit=-5` as "no limit" — must now fall back to default too.
    const negative = await handleApi(req("/api/candidates?limit=-5"), env);
    const { candidates: n } = (await negative!.json()) as { candidates: unknown[] };
    expect(n).toHaveLength(3);
  });

  it("sets a no-store Cache-Control on API responses", async () => {
    const res = await handleApi(req("/api/stats"), env);
    expect(res?.headers.get("cache-control")).toContain("no-store");
  });
});
