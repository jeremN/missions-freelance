import { redditAdapter } from "./reddit";
import type { SourceAdapter } from "./types";

export const adapters: SourceAdapter[] = [redditAdapter];

export function enabledAdapters(): SourceAdapter[] {
  return adapters.filter((a) => a.enabled);
}
