import { afterEach, describe, expect, it, vi } from "vitest";
import { createFetchJson } from "../../src/sources/http";

afterEach(() => vi.restoreAllMocks());

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    ...init,
  });
}

describe("createFetchJson", () => {
  it("sends a descriptive User-Agent and parses JSON", async () => {
    const fetchMock = vi.fn(async (_url, init?: RequestInit) => {
      expect(String((init?.headers as Record<string, string>)["User-Agent"])).toContain(
        "missions-free",
      );
      return jsonResponse({ ok: true }, { headers: { etag: 'W/"v1"' } });
    });
    const fetchJson = createFetchJson({ fetchImpl: fetchMock as typeof fetch, baseDelayMs: 0 });

    const res = await fetchJson<{ ok: boolean }>("https://api.example/x");
    expect(res.data).toEqual({ ok: true });
    expect(res.etag).toBe('W/"v1"');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns notModified on 304 without parsing a body", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 304 }));
    const fetchJson = createFetchJson({ fetchImpl: fetchMock as typeof fetch, baseDelayMs: 0 });

    const res = await fetchJson("https://api.example/x", { etag: 'W/"v1"' });
    expect(res.notModified).toBe(true);
    expect(res.data).toBeNull();
  });

  it("retries on 429 honoring Retry-After, then succeeds", async () => {
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        return new Response("rate limited", {
          status: 429,
          headers: { "retry-after": "0" },
        });
      }
      return jsonResponse({ ok: true });
    });
    const fetchJson = createFetchJson({ fetchImpl: fetchMock as typeof fetch, baseDelayMs: 0 });

    const res = await fetchJson<{ ok: boolean }>("https://api.example/x");
    expect(calls).toBe(2);
    expect(res.data).toEqual({ ok: true });
  });

  it("throws after exhausting retries on persistent 403", async () => {
    const fetchMock = vi.fn(async () => new Response("blocked", { status: 403 }));
    const fetchJson = createFetchJson({
      fetchImpl: fetchMock as typeof fetch,
      baseDelayMs: 0,
      maxRetries: 2,
    });

    await expect(fetchJson("https://api.example/x")).rejects.toThrow(/403/);
    expect(fetchMock).toHaveBeenCalledTimes(3); // initial + 2 retries
  });
});
