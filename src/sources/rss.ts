export interface RssItem {
  id: string; // <guid>, Atom <id>, else <link>
  title: string;
  link: string;
  description: string;
  pubDate?: string;
}

interface PartialItem {
  id?: string;
  title?: string;
  link?: string;
  description?: string;
  pubDate?: string;
}

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
  "&#39;": "'",
};

function decodeEntities(s: string): string {
  return s.replace(/&(?:amp|lt|gt|quot|apos|#39);/g, (m) => ENTITIES[m] ?? m);
}

/**
 * Parse RSS-2.0 / Atom `<item>` / `<entry>` elements out of an XML string.
 * Returns [] on malformed XML rather than throwing — adapters treat that as
 * "no new missions this tick".
 *
 * Only the fields the adapters need are extracted. CDATA sections are stripped
 * before parsing so HTMLRewriter's text events fire on the inner content.
 * Items missing both id/guid AND link, or missing title, are dropped silently.
 *
 * HTML-entity decoding is done by us, not HTMLRewriter — HTMLRewriter streams
 * text verbatim and does not resolve XML/HTML character references.
 */
export async function parseRssItems(xml: string): Promise<RssItem[]> {
  if (!xml || typeof xml !== "string") return [];

  // HTMLRewriter parses as HTML, so two things need pre-processing:
  //
  // 1. <link> is a void element in HTML (no end tag). We rename it so we can
  //    read its text content (RSS) or href attribute (Atom).
  //    Atom <link href="VALUE"/> is self-closing: in HTML parsing, />  is ignored
  //    for non-void elements, leaving an unclosed tag that swallows siblings.
  //    Fix: convert <link href="VALUE" .../> to <rsslink>VALUE</rsslink> so the
  //    tag is properly closed and siblings remain correct children of <entry>.
  //    Plain RSS <link>URL</link> becomes <rsslink>URL</rsslink>.
  //    NOTE: <rsslink> is an internal sentinel. A feed legitimately containing
  //    a `<rsslink>` element as content would be misrouted to current.link, but
  //    the child-selector (item > rsslink) limits collision to direct children
  //    of <item>/<entry> only — vanishingly unlikely in production feeds.
  //
  // 2. <![CDATA[...]]> sections are not emitted as text events by HTMLRewriter.
  //    Strip the CDATA wrapper so the content becomes plain text.
  //    NOTE: Non-greedy regex — if CDATA content illegally contains ']]>'
  //    (XML-invalid but seen in broken feeds), content after the first ']]>'
  //    is left as raw text and may surface as a stray text chunk on the
  //    parent element's buffer. Acceptable trade-off for a regex strip.
  const normalized = xml
    // Atom self-closing link: <link href="VALUE" .../> → <rsslink>VALUE</rsslink>
    .replace(/<link\s[^>]*\bhref="([^"]*)"[^>]*\/>/gi, "<rsslink>$1</rsslink>")
    // RSS text link: <link>...</link> → <rsslink>...</rsslink>
    .replace(/<link>/gi, "<rsslink>")
    .replace(/<\/link>/gi, "</rsslink>")
    // CDATA: strip the wrapper so text events fire normally
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");

  const items: PartialItem[] = [];
  let current: PartialItem | null = null;
  let textTarget: keyof PartialItem | null = null;
  let textBuffer = "";

  const rewriter = new HTMLRewriter()
    .on("item, entry", {
      element(el) {
        current = {};
        el.onEndTag(() => {
          if (current) items.push(current);
          current = null;
        });
      },
    })
    .on(
      "item > guid, entry > id, item > title, entry > title, item > description, entry > summary, entry > content, item > pubDate, entry > updated",
      {
        element(el) {
          if (!current) return;
          const tag = el.tagName.toLowerCase();
          textBuffer = "";
          textTarget =
            tag === "guid" || tag === "id"
              ? "id"
              : tag === "title"
                ? "title"
                : tag === "description" ||
                    tag === "summary" ||
                    tag === "content"
                  ? "description"
                  : tag === "pubdate" || tag === "updated"
                    ? "pubDate"
                    : null;
          el.onEndTag(() => {
            if (current && textTarget) {
              (current as Record<string, unknown>)[textTarget] =
                decodeEntities(textBuffer.trim());
            }
            textTarget = null;
            textBuffer = "";
          });
        },
        text(t) {
          if (textTarget) textBuffer += t.text;
        },
      },
    )
    .on("item > rsslink, entry > rsslink", {
      element(el) {
        if (!current) return;
        // Both Atom href and RSS text content have been normalised to
        // <rsslink>URL</rsslink> in the pre-processing step above.
        textBuffer = "";
        textTarget = "link";
        el.onEndTag(() => {
          if (current && textTarget === "link") {
            current.link = decodeEntities(textBuffer.trim());
          }
          textTarget = null;
          textBuffer = "";
        });
      },
      text(t) {
        if (textTarget === "link") textBuffer += t.text;
      },
    });

  try {
    // HTMLRewriter expects a Response stream; wrap the normalized xml string.
    await rewriter.transform(new Response(normalized)).text();
  } catch {
    return [];
  }

  const out: RssItem[] = [];
  for (const p of items) {
    if (!p.title) continue;
    const id = p.id ?? p.link;
    const link = p.link ?? p.id;
    if (!id || !link) continue;
    out.push({
      id,
      title: p.title,
      link,
      description: p.description ?? "",
      pubDate: p.pubDate,
    });
  }
  return out;
}
