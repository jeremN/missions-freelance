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
});
