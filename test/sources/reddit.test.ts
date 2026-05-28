import { describe, expect, it, vi } from "vitest";
import { redditAdapter } from "../../src/sources/reddit";
import type { AdapterCtx, FetchResult } from "../../src/sources/types";

function ctxReturning(listing: unknown): AdapterCtx {
  return {
    state: null,
    fetchJson: vi.fn(async (): Promise<FetchResult<unknown>> => ({
      data: listing,
      etag: 'W/"abc"',
      notModified: false,
    })),
  };
}

const listing = {
  data: {
    children: [
      {
        data: {
          id: "p1",
          title: "[Hiring] Senior React/TS freelancer, remote, 600€/j",
          selftext: "3 month mission, fully remote.",
          permalink: "/r/forhire/comments/p1/x/",
          created_utc: 1748340000,
        },
      },
      {
        data: {
          id: "p2",
          title: "[For Hire] I am a designer looking for work",
          selftext: "Hire me!",
          permalink: "/r/forhire/comments/p2/y/",
          created_utc: 1748340500,
        },
      },
    ],
  },
};

describe("redditAdapter", () => {
  it("maps only [Hiring] posts to RawMission", async () => {
    const out = await redditAdapter.fetch(ctxReturning(listing));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      source: "reddit",
      externalId: "p1",
      url: "https://www.reddit.com/r/forhire/comments/p1/x/",
      title: expect.stringContaining("Senior React"),
    });
    expect(out[0].postedAt).toBe(new Date(1748340000 * 1000).toISOString());
  });

  it("returns [] when the feed is unchanged (304)", async () => {
    const ctx: AdapterCtx = {
      state: { source: "reddit", etag: 'W/"abc"' },
      fetchJson: vi.fn(async () => ({ data: null, notModified: true })),
    };
    const out = await redditAdapter.fetch(ctx);
    expect(out).toEqual([]);
  });

  it("passes the stored etag to fetchJson", async () => {
    const fetchJson = vi.fn(async () => ({ data: listing, notModified: false }));
    await redditAdapter.fetch({ state: { source: "reddit", etag: 'W/"e"' }, fetchJson });
    expect(fetchJson).toHaveBeenCalledWith(expect.stringContaining("reddit.com"), {
      etag: 'W/"e"',
    });
  });

  it("returns [] for empty or malformed listings instead of throwing", async () => {
    expect(await redditAdapter.fetch(ctxReturning({ data: { children: [] } }))).toEqual(
      [],
    );
    expect(await redditAdapter.fetch(ctxReturning({ data: {} }))).toEqual([]);
    expect(await redditAdapter.fetch(ctxReturning({}))).toEqual([]);
  });

  it("drops malformed children and leaves postedAt undefined when created_utc is absent", async () => {
    const mixed = {
      data: {
        children: [
          // Valid [Hiring] but no created_utc → kept, postedAt undefined.
          {
            data: {
              id: "x",
              title: "[Hiring] Valid React role",
              selftext: "ok",
              permalink: "/r/forhire/comments/x/",
            },
          },
          // Missing permalink → dropped.
          { data: { id: "y", title: "[Hiring] no link", selftext: "" } },
          // Null child / inner — must not crash.
          null,
          { data: null },
        ],
      },
    };
    const out = await redditAdapter.fetch(ctxReturning(mixed));
    expect(out).toHaveLength(1);
    expect(out[0].externalId).toBe("x");
    expect(out[0].postedAt).toBeUndefined();
  });
});
