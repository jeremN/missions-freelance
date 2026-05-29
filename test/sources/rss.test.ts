import { describe, expect, it } from "vitest";
import { parseRssItems } from "../../src/sources/rss";

const RSS_2 = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Sample feed</title>
    <item>
      <guid isPermaLink="false">post-1</guid>
      <title>Senior React freelance, 6 mois</title>
      <link>https://example.test/post/1</link>
      <description><![CDATA[6 mois, full remote, 600€/j.]]></description>
      <pubDate>Wed, 28 May 2026 12:00:00 GMT</pubDate>
    </item>
    <item>
      <guid isPermaLink="true">https://example.test/post/2</guid>
      <title>TypeScript backend freelance</title>
      <link>https://example.test/post/2</link>
      <description>Node + TS, 3 mois renouvelable.</description>
    </item>
  </channel>
</rss>`;

const ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Sample feed</title>
  <entry>
    <id>tag:example.test,2026:1</id>
    <title>Vue freelance, full remote</title>
    <link href="https://example.test/atom/1" />
    <summary>Vue 3 + TS, 4 mois.</summary>
    <updated>2026-05-28T12:00:00Z</updated>
  </entry>
</feed>`;

describe("parseRssItems", () => {
  it("parses RSS-2.0 items with guid, title, link, description, pubDate", async () => {
    const items = await parseRssItems(RSS_2);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      id: "post-1",
      title: "Senior React freelance, 6 mois",
      link: "https://example.test/post/1",
      description: "6 mois, full remote, 600€/j.",
      pubDate: "Wed, 28 May 2026 12:00:00 GMT",
    });
    expect(items[1].id).toBe("https://example.test/post/2");
    expect(items[1].title).toBe("TypeScript backend freelance");
    expect(items[1].link).toBe("https://example.test/post/2");
    expect(items[1].description).toContain("Node + TS");
    expect(items[1].pubDate).toBeUndefined();
  });

  it("parses Atom entries with id, title, link href, summary, updated", async () => {
    const items = await parseRssItems(ATOM);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: "tag:example.test,2026:1",
      title: "Vue freelance, full remote",
      link: "https://example.test/atom/1",
      description: "Vue 3 + TS, 4 mois.",
      pubDate: "2026-05-28T12:00:00Z",
    });
  });

  it("returns [] on malformed XML rather than throwing", async () => {
    expect(await parseRssItems("<not really xml")).toEqual([]);
    expect(await parseRssItems("")).toEqual([]);
    expect(await parseRssItems("plain text body")).toEqual([]);
  });

  it("drops items missing title or both id and link, keeps siblings", async () => {
    const partial = `<?xml version="1.0"?>
      <rss><channel>
        <item><title>kept</title><link>https://x/1</link></item>
        <item><link>https://x/2</link></item> <!-- no title, dropped -->
        <item><title>also kept</title><guid>g3</guid></item>
      </channel></rss>`;
    const items = await parseRssItems(partial);
    expect(items.map((i) => i.title)).toEqual(["kept", "also kept"]);
    expect(items[0].id).toBe("https://x/1"); // falls back to link
    expect(items[1].id).toBe("g3");
  });

  it("decodes common HTML entities in text fields", async () => {
    const xml = `<?xml version="1.0"?>
      <rss><channel><item>
        <title>R&amp;D freelance &lt;senior&gt;</title>
        <link>https://x/1</link>
        <description>Need &quot;remote&quot; profile</description>
      </item></channel></rss>`;
    const items = await parseRssItems(xml);
    expect(items[0].title).toBe("R&D freelance <senior>");
    expect(items[0].description).toBe('Need "remote" profile');
  });
});
