import { afterEach, describe, expect, it, vi } from "vitest";
import { createFetchClients } from "../../src/sources/http";

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
    const { fetchJson } = createFetchClients({ fetchImpl: fetchMock as typeof fetch, baseDelayMs: 0 });

    const res = await fetchJson<{ ok: boolean }>("https://api.example/x");
    expect(res.data).toEqual({ ok: true });
    expect(res.etag).toBe('W/"v1"');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns notModified on 304 without parsing a body", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 304 }));
    const { fetchJson } = createFetchClients({ fetchImpl: fetchMock as typeof fetch, baseDelayMs: 0 });

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
    const { fetchJson } = createFetchClients({ fetchImpl: fetchMock as typeof fetch, baseDelayMs: 0 });

    const res = await fetchJson<{ ok: boolean }>("https://api.example/x");
    expect(calls).toBe(2);
    expect(res.data).toEqual({ ok: true });
  });

  it("throws after exhausting retries on persistent 403", async () => {
    const fetchMock = vi.fn(async () => new Response("blocked", { status: 403 }));
    const { fetchJson } = createFetchClients({
      fetchImpl: fetchMock as typeof fetch,
      baseDelayMs: 0,
      maxRetries: 2,
    });

    await expect(fetchJson("https://api.example/x")).rejects.toThrow(/403/);
    expect(fetchMock).toHaveBeenCalledTimes(3); // initial + 2 retries
  });
});

describe("fetchText", () => {
  it("returns body text and headers on 200", async () => {
    const fetchImpl: typeof fetch = (async () =>
      new Response("<rss><channel><item><title>hi</title></item></channel></rss>", {
        status: 200,
        headers: {
          etag: "W/\"abc\"",
          "last-modified": "Wed, 28 May 2026 12:00:00 GMT",
        },
      })) as unknown as typeof fetch;
    const { fetchText } = createFetchClients({ fetchImpl, baseDelayMs: 1, maxRetries: 2 });
    const res = await fetchText("https://example.test/feed.rss");
    expect(res.notModified).toBe(false);
    expect(res.data).toContain("<title>hi</title>");
    expect(res.etag).toBe("W/\"abc\"");
    expect(res.lastModified).toBe("Wed, 28 May 2026 12:00:00 GMT");
  });

  it("returns notModified on 304", async () => {
    const fetchImpl: typeof fetch = (async () =>
      new Response(null, { status: 304 })) as unknown as typeof fetch;
    const { fetchText } = createFetchClients({ fetchImpl, baseDelayMs: 1, maxRetries: 2 });
    const res = await fetchText("https://example.test/feed.rss", { etag: "W/\"abc\"" });
    expect(res.notModified).toBe(true);
    expect(res.data).toBeNull();
  });

  it("retries on 429 then succeeds", async () => {
    let n = 0;
    const fetchImpl: typeof fetch = (async () => {
      n += 1;
      if (n === 1) {
        return new Response("rate limited", { status: 429, headers: { "retry-after": "0" } });
      }
      return new Response("<rss></rss>", { status: 200 });
    }) as unknown as typeof fetch;
    const { fetchText } = createFetchClients({ fetchImpl, baseDelayMs: 1, maxRetries: 3 });
    const res = await fetchText("https://example.test/feed.rss");
    expect(res.notModified).toBe(false);
    expect(res.data).toBe("<rss></rss>");
    expect(n).toBe(2);
  });

  it("throws on a persistent 500 after max retries", async () => {
    const fetchImpl: typeof fetch = (async () =>
      new Response("server error", { status: 500 })) as unknown as typeof fetch;
    const { fetchText } = createFetchClients({ fetchImpl, baseDelayMs: 1, maxRetries: 2 });
    await expect(fetchText("https://example.test/feed.rss")).rejects.toThrow(/HTTP 500/);
  });

  it("treats an empty Retry-After header as no header (falls back to exp backoff)", async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = (async () => {
      calls += 1;
      if (calls === 1) {
        return new Response("rate limited", {
          status: 429,
          headers: { "retry-after": "" },
        });
      }
      return new Response("<rss></rss>", { status: 200 });
    }) as unknown as typeof fetch;
    const { fetchText } = createFetchClients({ fetchImpl, baseDelayMs: 1, maxRetries: 3 });
    const res = await fetchText("https://example.test/feed.rss");
    expect(calls).toBe(2);
    expect(res.data).toBe("<rss></rss>");
  });
});
