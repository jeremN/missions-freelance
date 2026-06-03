import { redditAdapter } from "./reddit";
import { freeWorkAdapter } from "./free-work";
import { codeurAdapter } from "./codeur";
import type { SourceAdapter } from "./types";

export const adapters: SourceAdapter[] = [
  redditAdapter,
  freeWorkAdapter,
  codeurAdapter,
];

export function enabledAdapters(): SourceAdapter[] {
  return adapters.filter((a) => a.enabled);
}
