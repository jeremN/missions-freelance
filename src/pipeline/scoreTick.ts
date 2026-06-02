import type { Env } from "../types/env";
import {
  MAX_BATCH,
  NEURONS_PER_CALL_GUESS,
  scoringProfile as defaultScoringProfile,
  type ScoringProfile,
} from "../config";
import {
  ScoringFailedError,
  scoreCandidate,
  type AiLike,
} from "../scoring/ai";
import { recordRun } from "../store/db";
import { remainingBudget } from "../store/budget";

export interface ScoreTickOptions {
  ai?: AiLike;
  profile?: ScoringProfile;
  now?: Date;
}

export interface ScoreTickResult {
  scored: number;
  failed: number;
  deferred: boolean;
  neurons: number;
}

interface PendingRow {
  id: number;
  source: string;
  externalId: string;
  url: string;
  title: string;
  body: string;
}

export async function runScoreTick(
  env: Env,
  opts: ScoreTickOptions = {},
): Promise<ScoreTickResult> {
  const ai = opts.ai ?? (env.AI as unknown as AiLike);
  const profile = opts.profile ?? defaultScoringProfile;
  const now = opts.now ?? new Date();
  const startedAt = now.toISOString();

  const budget = await remainingBudget(env.DB, now);
  if (budget < NEURONS_PER_CALL_GUESS) {
    // Defer — record the no-op for visibility.
    await recordRun(env.DB, {
      tick: "score",
      startedAt,
      finishedAt: new Date().toISOString(),
      stats: { deferred: true, budget, neurons: 0, scored: 0, failed: 0 },
    });
    return { scored: 0, failed: 0, deferred: true, neurons: 0 };
  }

  const batchSize = Math.min(
    MAX_BATCH,
    Math.floor(budget / NEURONS_PER_CALL_GUESS),
  );

  let scored = 0;
  let failed = 0;
  let neurons = 0;

  try {
    const { results: pending } = await env.DB
      .prepare(
        `SELECT id, source, external_id AS externalId, url, title, body
           FROM candidates
          WHERE status = 'pending'
          ORDER BY fetched_at ASC, id ASC
          LIMIT ?`,
      )
      .bind(batchSize)
      .all<PendingRow>();

    for (const c of pending) {
      // Mid-batch budget guard: batchSize is sized from an *estimate*
      // (NEURONS_PER_CALL_GUESS). If a real call costs far more than the guess, this
      // stops the tick once it has spent the day's remaining budget, instead of
      // overspending the daily allocation by a large multiple in a single tick.
      // Remaining candidates stay pending and are picked up next tick.
      if (neurons >= budget) break;
      try {
        const { extraction, neurons: n } = await scoreCandidate(ai, c, profile);
        neurons += n;
          const ts = new Date().toISOString();
        await env.DB.batch([
          env.DB
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
              c.id,
              c.source,
              c.url,
              c.title,
              extraction.is_real_mission ? 1 : 0,
              extraction.rate_eur_per_day,
              extraction.duration,
              extraction.remote,
              extraction.location,
              JSON.stringify(extraction.skills),
              extraction.client_type,
              extraction.score,
              extraction.reason,
              JSON.stringify(extraction),
              ts,
              ts,
            ),
          env.DB
            .prepare("UPDATE candidates SET status = 'scored' WHERE id = ?")
            .bind(c.id),
        ]);
        scored += 1;
      } catch (err) {
        failed += 1;
        if (err instanceof ScoringFailedError) {
          neurons += NEURONS_PER_CALL_GUESS * 2; // attribute the cost of two failed calls
          await env.DB
            .prepare("UPDATE candidates SET status = 'score-failed' WHERE id = ?")
            .bind(c.id)
            .run();
          // externalId and lastRaw are logged to Workers stderr (Cloudflare logs only,
          // not a structured sink). Newline injection would only affect log readability,
          // not downstream systems — low severity, acceptable in this context.
          console.error("score-failed:", c.externalId, err.lastRaw.slice(0, 200));
        } else {
          // Transient (D1 / network / AI binding) errors land here. Candidate
          // stays `pending` for a retry on the next tick; there is no per-row
          // backoff counter in M2a, so a deterministically-failing INSERT (e.g.,
          // a schema-level bug) would re-fire every tick — surface promptly in
          // the logs and address by code change rather than data change.
          console.error("score-tick error:", c.externalId, String(err));
        }
      }
    }
  } finally {
    // Always record the run so the audit trail is complete even if the
    // SELECT above throws or anything in the loop unwinds unexpectedly.
    await recordRun(env.DB, {
      tick: "score",
      startedAt,
      finishedAt: new Date().toISOString(),
      stats: { batchSize, scored, failed, neurons, deferred: false },
    });
  }

  return { scored, failed, deferred: false, neurons };
}
