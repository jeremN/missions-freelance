import type { AdapterCtx, AdapterRun, RawMission, SourceAdapter } from "./types";

// Pinned during M2b Task 2 recon (2026-05-29). The job_postings endpoint is
// public (no auth), returns Hydra JSON-LD, and supports a `contracts=contractor`
// filter that narrows from ~8900 total to ~6800 contractor/freelance listings.
//
// NOTE: the `contracts` filter is inclusive — postings with multiple contract
// types (e.g. ["contractor", "permanent"]) pass through as long as "contractor"
// is one of them. We intentionally don't post-filter; the M2a scorer is better
// positioned to judge whether a multi-contract posting is a real freelance one.
//
// NOTE: Free-Work responds with `cache-control: no-cache, private` — the
// `If-None-Match` / `If-Modified-Since` round-trips will not yield 304s in
// practice. We still store `etag` / `lastModified` for forward-compat in case
// that policy changes.
const FEED_URL =
  "https://www.free-work.com/api/job_postings?contracts=contractor";

// Loose types: the API uses Hydra JSON-LD; validate per-item rather than trusting the shape.
interface FreeWorkItem {
  id?: number;
  title?: string;
  slug?: string;
  description?: string;
  publishedAt?: string;
  contracts?: string[];
}

interface FreeWorkResponse {
  "hydra:member"?: Array<FreeWorkItem | null | undefined>;
}

function validItem(
  item: FreeWorkItem | null | undefined,
): item is FreeWorkItem & { id: number; title: string; slug: string } {
  return (
    !!item &&
    typeof item.id === "number" &&
    typeof item.title === "string" &&
    item.title.length > 0 &&
    typeof item.slug === "string" &&
    item.slug.length > 0
  );
}

export const freeWorkAdapter: SourceAdapter = {
  id: "free-work",
  enabled: true,

  async fetch(ctx: AdapterCtx): Promise<AdapterRun> {
    const res = await ctx.fetchJson<FreeWorkResponse>(FEED_URL, {
      etag: ctx.state?.etag,
      lastModified: ctx.state?.lastModified,
    });
    if (res.notModified || !res.data) {
      // Nothing changed upstream — don't overwrite the stored validators.
      return { missions: [] };
    }

    const members = Array.isArray(res.data["hydra:member"])
      ? res.data["hydra:member"]
      : [];

    const missions: RawMission[] = members.filter(validItem).map((item) => ({
      source: "free-work",
      externalId: String(item.id),
      url: `https://www.free-work.com/fr/tech-it/jobs/${encodeURIComponent(item.slug)}`,
      title: item.title,
      body: item.description ?? "",
      postedAt: item.publishedAt,
    }));

    return {
      missions,
      state: { etag: res.etag, lastModified: res.lastModified },
    };
  },
};
