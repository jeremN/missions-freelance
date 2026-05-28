import { DAILY_NEURON_BUDGET } from "../config";

/** Beginning of the UTC day containing `now`. */
function utcMidnight(now: Date): string {
  const d = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  return d.toISOString();
}

/**
 * How many Workers AI Neurons remain in today's free allocation.
 * Sums `stats.neurons` from `runs` rows started on/after today's UTC
 * midnight, treating missing/non-numeric fields as 0.
 */
export async function remainingBudget(
  db: D1Database,
  now: Date = new Date(),
): Promise<number> {
  const since = utcMidnight(now);
  const { results } = await db
    .prepare(
      `SELECT stats FROM runs
        WHERE started_at >= ?`,
    )
    .bind(since)
    .all<{ stats: string | null }>();

  let spent = 0;
  for (const r of results) {
    if (!r.stats) continue;
    try {
      const parsed: unknown = JSON.parse(r.stats);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        continue;
      }
      const n = (parsed as Record<string, unknown>).neurons;
      if (typeof n === "number" && Number.isFinite(n) && n > 0) spent += n;
    } catch {
      // Malformed JSON in stats should not crash the budget calc.
    }
  }
  return Math.max(0, DAILY_NEURON_BUDGET - spent);
}
