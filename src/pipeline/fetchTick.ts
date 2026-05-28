import type { Env } from "../types/env";
import type { PrefilterProfile } from "../matching/prefilter";
import { prefilter } from "../matching/prefilter";
import { createFetchJson } from "../sources/http";
import { enabledAdapters } from "../sources/registry";
import type { SourceAdapter } from "../sources/types";
import {
  insertCandidates,
  getSourceState,
  recordRun,
  setSourceState,
  type CandidateInput,
} from "../store/db";
import { profile as defaultProfile } from "../config";

export interface FetchTickOptions {
  adapters?: SourceAdapter[];
  profile?: PrefilterProfile;
}

export interface FetchTickResult {
  fetched: number;
  inserted: number;
  errors: number;
}

export async function runFetchTick(
  env: Env,
  opts: FetchTickOptions = {},
): Promise<FetchTickResult> {
  const adapters = opts.adapters ?? enabledAdapters();
  const profile = opts.profile ?? defaultProfile;
  const fetchJson = createFetchJson();
  const startedAt = new Date().toISOString();

  let fetched = 0;
  let errors = 0;
  let inserted = 0;
  const survivors: CandidateInput[] = [];

  try {
    for (const adapter of adapters) {
      try {
        const prior = await getSourceState(env.DB, adapter.id);
        const run = await adapter.fetch({ state: prior, fetchJson });
        fetched += run.missions.length;

        for (const m of run.missions) {
          const pf = prefilter(m, profile);
          if (pf.passed) {
            survivors.push({ ...m, tjm: pf.tjm, lowball: pf.lowball });
          }
        }

        // Merge: prefer adapter's new state, fall back to prior, so a 304
        // (no `run.state`) preserves the existing etag instead of clobbering it.
        await setSourceState(env.DB, {
          source: adapter.id,
          etag: run.state?.etag ?? prior?.etag ?? null,
          lastModified: run.state?.lastModified ?? prior?.lastModified ?? null,
          cursor: run.state?.cursor ?? prior?.cursor ?? null,
          lastRunAt: new Date().toISOString(),
        });
      } catch (err) {
        errors += 1;
        console.error("adapter failed:", adapter.id, err);
      }
    }

    inserted = await insertCandidates(env.DB, survivors);
    return { fetched, inserted, errors };
  } finally {
    // Always record the run so the audit trail is complete even if
    // insertCandidates above throws — operators need to see the attempt.
    await recordRun(env.DB, {
      tick: "fetch",
      startedAt,
      finishedAt: new Date().toISOString(),
      stats: { fetched, inserted, errors, adapters: adapters.length },
    });
  }
}
