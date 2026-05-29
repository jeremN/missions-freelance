import { AI_MODEL, NEURONS_PER_CALL_GUESS, type ScoringProfile } from "../config";
import { EXTRACTION_TOOL, parseExtraction, type Extraction } from "./schema";
import { buildScoringPrompt, type PromptCandidate } from "./prompt";

/** What we need from the Workers AI binding — narrowed so tests can fake it. */
export interface AiLike {
  run(
    model: string,
    input: {
      messages: Array<{ role: string; content: string }>;
      tools?: unknown[];
    },
  ): Promise<AiResponse>;
}

export interface AiResponse {
  response?: string;
  tool_calls?: Array<{
    function: { name: string; arguments: string };
  }>;
  usage?: { neurons?: number };
}

export interface ScoreResult {
  extraction: Extraction;
  neurons: number;
  retried: boolean;
}

export class ScoringFailedError extends Error {
  override name = "ScoringFailedError";
  constructor(
    message: string,
    public readonly lastRaw: string,
  ) {
    super(message);
  }
}

function extractToolArgs(res: AiResponse): string | null {
  const tc = res.tool_calls?.[0];
  if (!tc || tc.function?.name !== "extract_mission") return null;
  return tc.function.arguments;
}

function neuronsOf(res: AiResponse): number {
  const n = res.usage?.neurons;
  return typeof n === "number" && Number.isFinite(n) && n > 0
    ? n
    : NEURONS_PER_CALL_GUESS;
}

async function callOnce(
  ai: AiLike,
  c: PromptCandidate,
  profile: ScoringProfile,
  strict: boolean,
): Promise<{ res: AiResponse; extraction: Extraction | null; rawArgs: string }> {
  const { messages } = buildScoringPrompt(c, profile, { strict });
  const res = await ai.run(AI_MODEL, { messages, tools: [EXTRACTION_TOOL] });
  const args = extractToolArgs(res);
  if (!args) return { res, extraction: null, rawArgs: "" };
  try {
    const extraction = parseExtraction(JSON.parse(args));
    return { res, extraction, rawArgs: args };
  } catch {
    return { res, extraction: null, rawArgs: args };
  }
}

/**
 * Score one candidate. Calls the model with function-calling bound to the
 * extraction schema. On a malformed or missing tool-call, retries once with
 * a stricter system prompt. On a second failure throws ScoringFailedError so
 * the caller can mark the candidate as score-failed and move on.
 *
 * Neurons used across BOTH attempts are returned so the budget tracker sees
 * the true cost of a retry.
 */
export async function scoreCandidate(
  ai: AiLike,
  candidate: PromptCandidate,
  profile: ScoringProfile,
): Promise<ScoreResult> {
  const first = await callOnce(ai, candidate, profile, false);
  if (first.extraction) {
    return {
      extraction: first.extraction,
      neurons: neuronsOf(first.res),
      retried: false,
    };
  }

  const second = await callOnce(ai, candidate, profile, true);
  const totalNeurons = neuronsOf(first.res) + neuronsOf(second.res);

  if (second.extraction) {
    return {
      extraction: second.extraction,
      neurons: totalNeurons,
      retried: true,
    };
  }

  throw new ScoringFailedError(
    "model failed to produce a valid extraction after one retry",
    second.rawArgs || safeSnapshot(second.res),
  );
}

/**
 * Best-effort 500-char snapshot of a response for diagnostics.
 * Falls back to `String(res)` if `JSON.stringify` throws (e.g. on a
 * circular reference) so the diagnostic path can never replace
 * `ScoringFailedError` with an opaque `TypeError`.
 */
function safeSnapshot(res: AiResponse): string {
  try {
    return JSON.stringify(res).slice(0, 500);
  } catch {
    return String(res);
  }
}
