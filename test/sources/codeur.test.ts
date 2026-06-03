import { describe, expect, it, vi } from "vitest";
import { codeurAdapter } from "../../src/sources/codeur";
import { enabledAdapters } from "../../src/sources/registry";
import type { AdapterCtx, FetchResult } from "../../src/sources/types";

function ctxWith(res: FetchResult<string>): AdapterCtx {
  return {
    state: null,
    fetchText: vi.fn(async () => res) as never,
    fetchJson: vi.fn() as never,
  };
}

const SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>Tous les projets</title>
  <item>
    <title>Développeur freelance TypeScript/React</title>
    <link>https://www.codeur.com/projects/484422-dev</link>
    <pubDate>Wed, 03 Jun 2026 14:34:41 +0200</pubDate>
    <guid>484422</guid>
    <description type="html"><![CDATA[<p>Mission React, 3 mois, remote.</p>]]></description>
  </item>
  <item>
    <title>Projet sans date</title>
    <link>https://www.codeur.com/projects/999-x</link>
    <guid>999</guid>
    <description><![CDATA[Texte simple]]></description>
  </item>
</channel></rss>`;

const ok = (data: string): FetchResult<string> => ({
  data,
  etag: 'W/"codeur-1"',
  lastModified: "Wed, 03 Jun 2026 12:00:00 GMT",
  notModified: false,
});

describe("codeurAdapter", () => {
  it("maps RSS items into RawMission[] and surfaces cache validators", async () => {
    const run = await codeurAdapter.fetch(ctxWith(ok(SAMPLE)));
    expect(run.missions).toHaveLength(2);

    const first = run.missions[0];
    expect(first.source).toBe("codeur");
    expect(first.externalId).toBe("484422");
    expect(first.url).toBe("https://www.codeur.com/projects/484422-dev");
    expect(first.title).toContain("TypeScript/React");
    expect(first.body).toContain("Mission React");
    expect(first.postedAt).toBe("2026-06-03T12:34:41.000Z"); // RFC-822 +0200 → UTC

    expect(run.state?.etag).toBe('W/"codeur-1"');
    expect(run.state?.lastModified).toBe("Wed, 03 Jun 2026 12:00:00 GMT");
  });

  it("leaves postedAt undefined when pubDate is absent", async () => {
    const run = await codeurAdapter.fetch(ctxWith(ok(SAMPLE)));
    const second = run.missions.find((mn) => mn.externalId === "999");
    expect(second?.postedAt).toBeUndefined();
  });

  it("returns no missions and no state on notModified (304)", async () => {
    const run = await codeurAdapter.fetch(
      ctxWith({ data: null, notModified: true }),
    );
    expect(run.missions).toEqual([]);
    expect(run.state).toBeUndefined();
  });

  it("returns no missions for malformed XML instead of throwing", async () => {
    const run = await codeurAdapter.fetch(ctxWith(ok("not xml <<<")));
    expect(run.missions).toEqual([]);
  });

  it("is registered and enabled", () => {
    expect(enabledAdapters().map((a) => a.id)).toContain("codeur");
  });
});
