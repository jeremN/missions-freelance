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
  const survivors: CandidateInput[] = [];

  for (const adapter of adapters) {
    try {
      const state = await getSourceState(env.DB, adapter.id);
      const raw = await adapter.fetch({ state, fetchJson });
      fetched += raw.length;

      for (const m of raw) {
        const pf = prefilter(m, profile);
        if (pf.passed) {
          survivors.push({ ...m, tjm: pf.tjm, lowball: pf.lowball });
        }
      }

      await setSourceState(env.DB, {
        source: adapter.id,
        lastRunAt: new Date().toISOString(),
      });
    } catch (err) {
      errors += 1;
      console.error("adapter %s failed:", adapter.id, err);
    }
  }

  const inserted = await insertCandidates(env.DB, survivors);

  await recordRun(env.DB, {
    tick: "fetch",
    startedAt,
    finishedAt: new Date().toISOString(),
    stats: { fetched, inserted, errors, adapters: adapters.length },
  });

  return { fetched, inserted, errors };
}
