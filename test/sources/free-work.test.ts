import { describe, expect, it, vi } from "vitest";
import { freeWorkAdapter } from "../../src/sources/free-work";
import type { AdapterCtx, FetchResult } from "../../src/sources/types";
import freeWorkFixture from "./fixtures/free-work-sample.json";

function ctxWith(json: FetchResult<unknown>): AdapterCtx {
  return {
    state: null,
    fetchJson: vi.fn(async () => json) as never,
    fetchText: vi.fn() as never,
  };
}

describe("freeWorkAdapter", () => {
  it("maps captured JSON items into RawMission[]", async () => {
    const run = await freeWorkAdapter.fetch(
      ctxWith({
        data: freeWorkFixture,
        etag: 'W/"new-etag"',
        lastModified: "Fri, 29 May 2026 09:00:00 GMT",
        notModified: false,
      }),
    );
    expect(run.missions.length).toBeGreaterThan(0);
    for (const m of run.missions) {
      expect(m.source).toBe("free-work");
      expect(typeof m.externalId).toBe("string");
      expect(m.externalId.length).toBeGreaterThan(0);
      expect(m.url).toMatch(/^https?:\/\//);
      expect(typeof m.title).toBe("string");
      expect(m.title.length).toBeGreaterThan(0);
    }
    expect(run.state?.etag).toBe('W/"new-etag"');
    expect(run.state?.lastModified).toBe("Fri, 29 May 2026 09:00:00 GMT");
  });

  it("returns no missions on notModified", async () => {
    const run = await freeWorkAdapter.fetch(
      ctxWith({ data: null, notModified: true }),
    );
    expect(run.missions).toEqual([]);
    expect(run.state).toBeUndefined();
  });

  it("drops malformed items (missing id or slug) via the per-item validator", async () => {
    const run = await freeWorkAdapter.fetch(
      ctxWith({
        data: {
          "hydra:member": [
            { description: "no id, no slug" },
            { id: 123, title: "Has title but no slug" },
            { id: 456, slug: "has-slug-but-no-title" },
          ],
        },
        etag: undefined,
        lastModified: undefined,
        notModified: false,
      }),
    );
    expect(run.missions).toEqual([]);
  });

  it("parses a bare top-level array (2026-06-02 API shape) and drops malformed items", async () => {
    const run = await freeWorkAdapter.fetch(
      ctxWith({
        data: [
          {
            id: 1,
            title: "Senior React",
            slug: "senior-react",
            description: "x",
            publishedAt: "2026-06-01T00:00:00Z",
          },
          { description: "no id/slug" }, // dropped
          { id: 2, title: "No slug" }, // dropped
          null, // dropped
        ],
        notModified: false,
      }),
    );
    expect(run.missions.map((m) => m.externalId)).toEqual(["1"]);
    expect(run.missions[0].url).toContain("senior-react");
  });

  it("passes the configured URL with the user's etag to fetchJson", async () => {
    const fetchJson = vi.fn(async () => ({
      data: freeWorkFixture,
      notModified: false,
    })) as never as AdapterCtx["fetchJson"];
    const run = await freeWorkAdapter.fetch({
      state: {
        source: "free-work",
        etag: 'W/"prior"',
        lastModified: null,
        cursor: null,
        lastRunAt: null,
      },
      fetchJson,
      fetchText: vi.fn() as never,
    });
    expect(fetchJson).toHaveBeenCalledTimes(1);
    const [calledUrl, calledOpts] = (
      fetchJson as unknown as ReturnType<typeof vi.fn>
    ).mock.calls[0];
    expect(typeof calledUrl).toBe("string");
    expect(calledUrl).toMatch(/^https:\/\/[^/]*free-work\./);
    expect(calledOpts.etag).toBe('W/"prior"');
    expect(run.missions.length).toBeGreaterThan(0);
  });
});
