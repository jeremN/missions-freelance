import { prefilter, type PrefilterProfile } from "../matching/prefilter";
import type { RawMission } from "../sources/types";
import type { CandidateInput } from "../store/db";

/**
 * Run the prefilter over raw missions and return the survivors as CandidateInputs
 * (carrying the extracted tjm + lowball flag). Shared by the fetch-tick (pull
 * adapters) and the inbound-email path so both gate candidates identically.
 */
export function selectCandidates(
  missions: RawMission[],
  profile: PrefilterProfile,
): CandidateInput[] {
  const out: CandidateInput[] = [];
  for (const m of missions) {
    const pf = prefilter(m, profile);
    if (pf.passed) out.push({ ...m, tjm: pf.tjm, lowball: pf.lowball });
  }
  return out;
}
