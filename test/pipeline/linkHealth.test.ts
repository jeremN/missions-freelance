import { describe, expect, it, vi } from "vitest";
import { createLinkValidator } from "../../src/pipeline/linkHealth";

/** A fake fetch that returns queued responses in order, then 200s. */
function fetchReturning(...responses: Response[]): typeof fetch {
  const queue = [...responses];
  return (async () =>
    queue.shift() ?? new Response(null, { status: 200 })) as unknown as typeof fetch;
}

describe("createLinkValidator", () => {
  it("is ok on a direct 200", async () => {
    const v = createLinkValidator({
      fetchImpl: fetchReturning(new Response(null, { status: 200 })),
    });
    expect(await v.check("https://e/x", "free-work")).toEqual({ ok: true, status: 200 });
  });

  it("is not-ok on a 3xx and captures the redirect target", async () => {
    const v = createLinkValidator({
      fetchImpl: fetchReturning(
        new Response(null, { status: 301, headers: { location: "https://e/jobs" } }),
      ),
    });
    expect(await v.check("https://e/x", "free-work")).toEqual({
      ok: false,
      status: 301,
      redirectedTo: "https://e/jobs",
    });
  });

  it("is not-ok on a 404", async () => {
    const v = createLinkValidator({
      fetchImpl: fetchReturning(new Response(null, { status: 404 })),
    });
    expect(await v.check("https://e/x", "free-work")).toEqual({ ok: false, status: 404 });
  });

  it("is not-ok on a 5xx", async () => {
    const v = createLinkValidator({
      fetchImpl: fetchReturning(new Response(null, { status: 503 })),
    });
    expect(await v.check("https://e/x", "free-work")).toEqual({ ok: false, status: 503 });
  });

  it("omits redirectedTo when a 3xx carries no Location header", async () => {
    const v = createLinkValidator({
      fetchImpl: fetchReturning(new Response(null, { status: 302 })),
    });
    expect(await v.check("https://e/x", "free-work")).toEqual({ ok: false, status: 302 });
  });

  it("skips allowlisted sources without any network call", async () => {
    const spy = vi.fn(
      async () => new Response(null, { status: 500 }),
    ) as unknown as typeof fetch;
    const v = createLinkValidator({ fetchImpl: spy });
    expect(await v.check("https://linkedin.com/jobs/view/1", "linkedin")).toEqual({
      ok: true,
      status: null,
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it("falls back to GET when HEAD returns 405", async () => {
    const impl = vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === "HEAD"
        ? new Response(null, { status: 405 })
        : new Response(null, { status: 200 }),
    ) as unknown as typeof fetch;
    const v = createLinkValidator({ fetchImpl: impl });
    expect(await v.check("https://e/x", "free-work")).toEqual({ ok: true, status: 200 });
    expect(impl).toHaveBeenCalledTimes(2);
  });

  it("is not-ok with status null when the request throws", async () => {
    const impl = vi.fn(async () => {
      throw new Error("network");
    }) as unknown as typeof fetch;
    const v = createLinkValidator({ fetchImpl: impl });
    expect(await v.check("https://e/x", "free-work")).toEqual({ ok: false, status: null });
  });
});
