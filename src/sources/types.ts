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
  fetchJson: <T>(
    url: string,
    opts?: { etag?: string | null; lastModified?: string | null },
  ) => Promise<FetchResult<T>>;
}

export interface SourceAdapter {
  id: string;
  enabled: boolean;
  fetch(ctx: AdapterCtx): Promise<RawMission[]>;
}
