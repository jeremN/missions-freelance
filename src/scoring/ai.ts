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
  response?: string | null;
  tool_calls?: Array<{
    // Native Workers AI shape: flat name + already-parsed arguments object.
    name?: string;
    arguments?: unknown;
    // OpenAI-compatible shape: nested under `function`, arguments as JSON string.
    function?: { name: string; arguments: string };
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

/**
 * Pull the `extract_mission` arguments out of a Workers AI tool-call response.
 *
 * Workers AI returns the NATIVE shape — `{ name, arguments }` with `arguments`
 * already parsed into an object. Some models / the OpenAI-compat path instead
 * return `{ function: { name, arguments } }` with `arguments` as a JSON string.
 * Accept both and return the raw arguments value (object or string); `callOnce`
 * normalises it. Returns null when there is no `extract_mission` tool call.
 */
function extractToolArgs(res: AiResponse): unknown {
  const tc = res.tool_calls?.[0];
  if (!tc) return null;
  const name = tc.name ?? tc.function?.name;
  if (name !== "extract_mission") return null;
  return tc.arguments ?? tc.function?.arguments ?? null;
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
  if (args == null) return { res, extraction: null, rawArgs: "" };
  // Native shape gives an object; OpenAI-compat gives a JSON string. Keep a
  // string form for diagnostics either way.
  const rawArgs = typeof args === "string" ? args : JSON.stringify(args);
  try {
    const parsed = typeof args === "string" ? JSON.parse(args) : args;
    const extraction = parseExtraction(parsed);
    return { res, extraction, rawArgs };
  } catch {
    return { res, extraction: null, rawArgs };
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
