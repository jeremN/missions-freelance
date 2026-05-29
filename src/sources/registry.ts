import { redditAdapter } from "./reddit";
import { freeWorkAdapter } from "./free-work";
import type { SourceAdapter } from "./types";

export const adapters: SourceAdapter[] = [redditAdapter, freeWorkAdapter];

export function enabledAdapters(): SourceAdapter[] {
  return adapters.filter((a) => a.enabled);
}
