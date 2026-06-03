import type { AdapterCtx, AdapterRun, RawMission, SourceAdapter } from "./types";
import { parseRssItems } from "./rss";

// Codeur.com is a French freelance-project marketplace exposing a public RSS 2.0
// feed of the newest projects. Each <item> carries a numeric <guid> (project id),
// <title>, <link>, <pubDate> (RFC-822) and a CDATA HTML <description>.
const FEED_URL = "https://www.codeur.com/projects.rss";

/** Convert an RFC-822 RSS pubDate to ISO-8601, or undefined if absent/invalid. */
function toIso(pubDate: string | undefined): string | undefined {
  if (!pubDate) return undefined;
  const t = new Date(pubDate);
  return Number.isNaN(t.getTime()) ? undefined : t.toISOString();
}

export const codeurAdapter: SourceAdapter = {
  id: "codeur",
  enabled: true,

  async fetch(ctx: AdapterCtx): Promise<AdapterRun> {
    const res = await ctx.fetchText(FEED_URL, {
      etag: ctx.state?.etag,
      lastModified: ctx.state?.lastModified,
    });
    if (res.notModified || !res.data) {
      // Nothing changed upstream — don't overwrite the stored validators.
      return { missions: [] };
    }

    const items = await parseRssItems(res.data);
    const missions: RawMission[] = items.map((item) => ({
      source: "codeur",
      externalId: item.id,
      url: item.link,
      title: item.title,
      body: item.description,
      postedAt: toIso(item.pubDate),
    }));

    return {
      missions,
      state: { etag: res.etag, lastModified: res.lastModified },
    };
  },
};
