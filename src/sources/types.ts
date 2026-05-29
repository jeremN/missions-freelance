import type { FetchJson, FetchText } from "./http";

export interface RawMission {
  source: string;
  externalId: string;
  url: string;
  title: string;
  body: string;
  postedAt?: string;
}

export interface SourceState {
  source: string;
  etag?: string | null;
  lastModified?: string | null;
  cursor?: string | null;
  lastRunAt?: string | null;
}

export interface FetchResult<T> {
  data: T | null;
  etag?: string;
  lastModified?: string;
  notModified: boolean;
}

export interface AdapterCtx {
  state: SourceState | null;
  fetchJson: FetchJson;
  fetchText: FetchText;
}

/**
 * What an adapter's `fetch()` returns. The optional `state` lets the adapter
 * surface fresh cache validators (etag / lastModified / cursor) so the pipeline
 * can persist them — required for conditional requests to actually work across
 * ticks. Adapters that don't need this can omit `state`; the pipeline then
 * preserves whatever was already stored.
 */
export interface AdapterRun {
  missions: RawMission[];
  state?: Partial<Pick<SourceState, "etag" | "lastModified" | "cursor">>;
}

export interface SourceAdapter {
  id: string;
  enabled: boolean;
  fetch(ctx: AdapterCtx): Promise<AdapterRun>;
}
