export type Remote = "full" | "hybrid" | "onsite" | "unknown";
export type ClientType = "direct" | "esn" | "agency" | "unknown";

export interface MissionInput {
  candidateId: number;
  source: string;
  url: string;
  title: string;
  isRealMission: boolean;
  rateEurDay: number | null;
  duration: string | null;
  remote: Remote;
  location: string | null;
  skills: string[];
  clientType: ClientType;
  score: number;
  reason: string;
  rawResponse: string;
}

export interface MissionRow extends MissionInput {
  id: number;
  firstSeen: string;
  lastSeen: string;
  notified: boolean;
}

interface MissionDbRow {
  id: number;
  candidateId: number;
  source: string;
  url: string;
  title: string;
  isRealMission: number;
  rateEurDay: number | null;
  duration: string | null;
  remote: string;
  location: string | null;
  skills: string | null;
  clientType: string;
  score: number;
  reason: string | null;
  rawResponse: string | null;
  firstSeen: string;
  lastSeen: string;
  notified: number;
}

/**
 * Defensive parse for the `skills` column: any malformed JSON, non-array
 * payload, or non-string element collapses to `[]` rather than violating
 * `MissionRow.skills: string[]` downstream.
 */
function parseSkills(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((s): s is string => typeof s === "string")
      : [];
  } catch {
    return [];
  }
}

function hydrate(r: MissionDbRow): MissionRow {
  return {
    id: r.id,
    candidateId: r.candidateId,
    source: r.source,
    url: r.url,
    title: r.title,
    isRealMission: Boolean(r.isRealMission),
    rateEurDay: r.rateEurDay,
    duration: r.duration,
    remote: r.remote as Remote,
    location: r.location,
    skills: parseSkills(r.skills),
    clientType: r.clientType as ClientType,
    score: r.score,
    reason: r.reason ?? "",
    rawResponse: r.rawResponse ?? "",
    firstSeen: r.firstSeen,
    lastSeen: r.lastSeen,
    notified: Boolean(r.notified),
  };
}

const SELECT_COLS = `
  id, candidate_id AS candidateId, source, url, title,
  is_real_mission AS isRealMission, rate_eur_day AS rateEurDay,
  duration, remote, location, skills, client_type AS clientType,
  score, reason, raw_response AS rawResponse,
  first_seen AS firstSeen, last_seen AS lastSeen, notified`;

/**
 * Insert a mission for a candidate, or update score / lastSeen / extracted
 * fields if a mission for that candidate already exists. firstSeen is preserved
 * across re-scorings (re-scoring is not part of M2a but the column is honest).
 */
export async function upsertMission(
  db: D1Database,
  m: MissionInput,
): Promise<void> {
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO missions (
         candidate_id, source, url, title, is_real_mission, rate_eur_day,
         duration, remote, location, skills, client_type, score, reason,
         raw_response, first_seen, last_seen
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(candidate_id) DO UPDATE SET
         is_real_mission = excluded.is_real_mission,
         rate_eur_day    = excluded.rate_eur_day,
         duration        = excluded.duration,
         remote          = excluded.remote,
         location        = excluded.location,
         skills          = excluded.skills,
         client_type     = excluded.client_type,
         score           = excluded.score,
         reason          = excluded.reason,
         raw_response    = excluded.raw_response,
         last_seen       = excluded.last_seen`,
    )
    .bind(
      m.candidateId,
      m.source,
      m.url,
      m.title,
      m.isRealMission ? 1 : 0,
      m.rateEurDay,
      m.duration,
      m.remote,
      m.location,
      JSON.stringify(m.skills),
      m.clientType,
      m.score,
      m.reason,
      m.rawResponse,
      now,
      now,
    )
    .run();
}

export async function getMissions(
  db: D1Database,
  opts: { limit?: number; minScore?: number } = {},
): Promise<MissionRow[]> {
  const limit = Math.min(opts.limit ?? 100, 500);
  const minScore = opts.minScore ?? 0;
  const { results } = await db
    .prepare(
      `SELECT ${SELECT_COLS} FROM missions
        WHERE score >= ?
        ORDER BY score DESC, last_seen DESC
        LIMIT ?`,
    )
    .bind(minScore, limit)
    .all<MissionDbRow>();
  return results.map(hydrate);
}

export async function getMissionsForCandidate(
  db: D1Database,
  candidateId: number,
): Promise<MissionRow | null> {
  const row = await db
    .prepare(`SELECT ${SELECT_COLS} FROM missions WHERE candidate_id = ?`)
    .bind(candidateId)
    .first<MissionDbRow>();
  return row ? hydrate(row) : null;
}

/**
 * Missions eligible for the daily digest: never-notified, real, score ≥ minScore.
 * Served by idx_missions_notified(notified, score).
 */
export async function getUnnotifiedMissions(
  db: D1Database,
  opts: { minScore: number; limit: number },
): Promise<MissionRow[]> {
  const minScore = opts.minScore;
  const limit = Math.min(opts.limit, 500);
  const { results } = await db
    .prepare(
      `SELECT ${SELECT_COLS} FROM missions
        WHERE notified = 0 AND is_real_mission = 1 AND score >= ?
        ORDER BY score DESC, last_seen DESC
        LIMIT ?`,
    )
    .bind(minScore, limit)
    .all<MissionDbRow>();
  return results.map(hydrate);
}

/** Mark the given mission ids as notified. No-op on an empty list. */
export async function markNotified(db: D1Database, ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => "?").join(", ");
  await db
    .prepare(`UPDATE missions SET notified = 1 WHERE id IN (${placeholders})`)
    .bind(...ids)
    .run();
}
