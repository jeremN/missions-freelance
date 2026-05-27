import type { RawMission, SourceState } from "../sources/types";

export interface CandidateInput extends RawMission {
  tjm: number | null;
  lowball: boolean;
}

export interface CandidateRow extends CandidateInput {
  id: number;
  fetchedAt: string;
  status: string;
}

export interface RunInput {
  tick: string;
  startedAt: string;
  finishedAt?: string;
  stats?: unknown;
}

export interface Stats {
  totalCandidates: number;
  pending: number;
  totalRuns: number;
}

/** Insert candidates, ignoring duplicates on (source, external_id). Returns rows added. */
export async function insertCandidates(
  db: D1Database,
  items: CandidateInput[],
): Promise<number> {
  if (items.length === 0) return 0;
  const now = new Date().toISOString();
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO candidates
       (source, external_id, url, title, body, posted_at, fetched_at, status, tjm, lowball)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
  );
  const batch = items.map((i) =>
    stmt.bind(
      i.source,
      i.externalId,
      i.url,
      i.title,
      i.body,
      i.postedAt ?? null,
      now,
      i.tjm,
      i.lowball ? 1 : 0,
    ),
  );
  const results = await db.batch(batch);
  return results.reduce((sum, r) => sum + (r.meta.changes ?? 0), 0);
}

export async function getCandidates(
  db: D1Database,
  opts: { limit?: number; status?: string } = {},
): Promise<CandidateRow[]> {
  const limit = Math.min(opts.limit ?? 100, 500);
  const where = opts.status ? "WHERE status = ?" : "";
  const stmt = db.prepare(
    `SELECT id, source, external_id AS externalId, url, title, body,
            posted_at AS postedAt, fetched_at AS fetchedAt, status,
            tjm, lowball
       FROM candidates ${where}
       ORDER BY fetched_at DESC, id DESC
       LIMIT ?`,
  );
  const bound = opts.status ? stmt.bind(opts.status, limit) : stmt.bind(limit);
  const { results } = await bound.all<CandidateRow & { lowball: number }>();
  return results.map((r) => ({ ...r, lowball: Boolean(r.lowball) }));
}

export async function getSourceState(
  db: D1Database,
  source: string,
): Promise<SourceState | null> {
  const row = await db
    .prepare(
      `SELECT source, etag, last_modified AS lastModified, cursor, last_run_at AS lastRunAt
         FROM source_state WHERE source = ?`,
    )
    .bind(source)
    .first<SourceState>();
  return row ?? null;
}

export async function setSourceState(
  db: D1Database,
  state: SourceState,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO source_state (source, etag, last_modified, cursor, last_run_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(source) DO UPDATE SET
         etag = excluded.etag,
         last_modified = excluded.last_modified,
         cursor = excluded.cursor,
         last_run_at = excluded.last_run_at`,
    )
    .bind(
      state.source,
      state.etag ?? null,
      state.lastModified ?? null,
      state.cursor ?? null,
      state.lastRunAt ?? null,
    )
    .run();
}

export async function recordRun(db: D1Database, run: RunInput): Promise<void> {
  await db
    .prepare(
      `INSERT INTO runs (tick, started_at, finished_at, stats) VALUES (?, ?, ?, ?)`,
    )
    .bind(
      run.tick,
      run.startedAt,
      run.finishedAt ?? null,
      run.stats ? JSON.stringify(run.stats) : null,
    )
    .run();
}

export async function getStats(db: D1Database): Promise<Stats> {
  const [cand, pending, runs] = await db.batch([
    db.prepare("SELECT COUNT(*) AS n FROM candidates"),
    db.prepare("SELECT COUNT(*) AS n FROM candidates WHERE status = 'pending'"),
    db.prepare("SELECT COUNT(*) AS n FROM runs"),
  ]);
  const n = (r: D1Result) =>
    Number((r.results?.[0] as { n: number } | undefined)?.n ?? 0);
  return { totalCandidates: n(cand), pending: n(pending), totalRuns: n(runs) };
}
