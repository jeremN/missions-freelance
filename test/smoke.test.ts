import { env } from "cloudflare:test";
import { expect, it } from "vitest";

it("has a migrated D1 with the candidates table", async () => {
  const row = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='candidates'"
  ).first<{ name: string }>();
  expect(row?.name).toBe("candidates");
});
