import type { AdapterCtx, RawMission, SourceAdapter } from "./types";

const FEED_URL = "https://www.reddit.com/r/forhire/new.json?limit=50";

// Loose types: Reddit can A/B test fields or return deleted-post stubs.
// Validate per-post rather than trusting the shape.
interface RedditPost {
  id?: string;
  title?: string;
  selftext?: string;
  permalink?: string;
  created_utc?: number;
}
interface RedditListing {
  data?: {
    children?: Array<{ data?: RedditPost } | null | undefined>;
  };
}

function validPost(
  p: RedditPost | undefined | null,
): p is RedditPost & { id: string; title: string; permalink: string } {
  return (
    !!p &&
    typeof p.id === "string" &&
    typeof p.title === "string" &&
    typeof p.permalink === "string"
  );
}

export const redditAdapter: SourceAdapter = {
  id: "reddit",
  enabled: true,

  async fetch(ctx: AdapterCtx): Promise<RawMission[]> {
    const res = await ctx.fetchJson<RedditListing>(FEED_URL, {
      etag: ctx.state?.etag,
    });
    if (res.notModified || !res.data) return [];

    const children = Array.isArray(res.data.data?.children)
      ? res.data.data.children
      : [];

    return children
      .map((c) => c?.data)
      .filter(validPost)
      .filter((p) => p.title.trim().toLowerCase().startsWith("[hiring]"))
      .map((p) => {
        const ts =
          typeof p.created_utc === "number" && Number.isFinite(p.created_utc)
            ? new Date(p.created_utc * 1000).toISOString()
            : undefined;
        const url = p.permalink.startsWith("http")
          ? p.permalink
          : `https://www.reddit.com${p.permalink}`;
        return {
          source: "reddit",
          externalId: p.id,
          url,
          title: p.title,
          body: p.selftext ?? "",
          postedAt: ts,
        };
      });
  },
};
