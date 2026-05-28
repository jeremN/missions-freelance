import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { insertCandidates } from "../src/store/db";

beforeEach(async () => {
  await env.DB.exec("DELETE FROM candidates");
});

describe("worker fetch routing", () => {
  it("serves /api/candidates from the worker", async () => {
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
    const res = await SELF.fetch("https://worker.test/api/candidates");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { candidates: unknown[] };
    expect(body.candidates).toHaveLength(1);
  });

  it("serves the dashboard HTML at /", async () => {
    const res = await SELF.fetch("https://worker.test/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("missions-free");
  });
});
