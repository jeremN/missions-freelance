import type { AdapterCtx, RawMission, SourceAdapter } from "./types";

const FEED_URL = "https://www.reddit.com/r/forhire/new.json?limit=50";

interface RedditListing {
  data: {
    children: Array<{
      data: {
        id: string;
        title: string;
        selftext: string;
        permalink: string;
        created_utc: number;
      };
    }>;
  };
}

export const redditAdapter: SourceAdapter = {
  id: "reddit",
  enabled: true,

  async fetch(ctx: AdapterCtx): Promise<RawMission[]> {
    const res = await ctx.fetchJson<RedditListing>(FEED_URL, {
      etag: ctx.state?.etag,
    });
    if (res.notModified || !res.data) return [];

    return res.data.data.children
      .map((c) => c.data)
      .filter((p) => p.title.trim().toLowerCase().startsWith("[hiring]"))
      .map((p) => ({
        source: "reddit",
        externalId: p.id,
        url: `https://www.reddit.com${p.permalink}`,
        title: p.title,
        body: p.selftext ?? "",
        postedAt: new Date(p.created_utc * 1000).toISOString(),
      }));
  },
};
