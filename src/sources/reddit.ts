import type { AdapterCtx, AdapterRun, SourceAdapter } from "./types";

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
  // Disabled 2026-06-02: Reddit now hard-403s unauthenticated `.json` access
  // (verified from both datacenter and residential IPs). The parser below is
  // kept and unit-tested for easy revival once OAuth (oauth.reddit.com) is added.
  enabled: false,

  async fetch(ctx: AdapterCtx): Promise<AdapterRun> {
    const res = await ctx.fetchJson<RedditListing>(FEED_URL, {
      etag: ctx.state?.etag,
    });
    if (res.notModified || !res.data) {
      // Nothing changed upstream — don't overwrite the stored etag.
      return { missions: [] };
    }

    const children = Array.isArray(res.data.data?.children)
      ? res.data.data.children
      : [];

    const missions = children
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

    return {
      missions,
      state: { etag: res.etag, lastModified: res.lastModified },
    };
  },
};
