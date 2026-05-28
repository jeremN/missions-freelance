import type { Remote, ClientType } from "../store/missions";

export interface Extraction {
  is_real_mission: boolean;
  rate_eur_per_day: number | null;
  duration: string | null;
  remote: Remote;
  location: string | null;
  skills: string[];
  client_type: ClientType;
  score: number;
  reason: string;
}

const REMOTE_VALUES = ["full", "hybrid", "onsite", "unknown"] as const;
const CLIENT_VALUES = ["direct", "esn", "agency", "unknown"] as const;

/**
 * The JSON schema we declare to Workers AI's function-calling. The model
 * binds its output to this shape, so most malformed responses are blocked
 * at the source. We still validate in code (`parseExtraction`) for defense
 * in depth and to give callers a typed result.
 */
export const EXTRACTION_TOOL = {
  type: "function" as const,
  function: {
    name: "extract_mission",
    description:
      "Extract structured fields from a freelance mission posting and score its relevance for the configured profile.",
    parameters: {
      type: "object",
      required: ["is_real_mission", "remote", "client_type", "score", "reason"],
      properties: {
        is_real_mission: {
          type: "boolean",
          description:
            "True only if the post is offering a freelance/contract mission (not a CDI/permanent role, not self-promo, not a recycled call for candidates).",
        },
        rate_eur_per_day: {
          type: ["integer", "null"],
          minimum: 0,
          description: "Daily rate in EUR if stated, else null.",
        },
        duration: {
          type: ["string", "null"],
          description:
            "Free-form duration string, e.g. '6 mois', '3-6 months', 'long term'. Null if unstated.",
        },
        remote: {
          enum: REMOTE_VALUES,
          description:
            "'full' = fully remote; 'hybrid' = partial on-site; 'onsite' = on-site required; 'unknown' if unstated.",
        },
        location: {
          type: ["string", "null"],
          description:
            "City or region if stated (e.g. 'Paris', 'Île-de-France'), else null.",
        },
        skills: {
          type: "array",
          items: { type: "string" },
          default: [],
          description: "Technical skills mentioned in the post.",
        },
        client_type: {
          enum: CLIENT_VALUES,
          description:
            "'direct' = end client; 'esn' = ESN / service company middleman; 'agency' = recruiting agency; 'unknown' if unclear.",
        },
        score: {
          type: "integer",
          minimum: 0,
          maximum: 100,
          description: "0–100 relevance score for the configured profile.",
        },
        reason: {
          type: "string",
          maxLength: 240,
          description: "One-line justification for the score.",
        },
      },
    },
  },
} as const;

/** Type guard / runtime validator for extraction payloads. Throws on bad input. */
export function parseExtraction(input: unknown): Extraction {
  if (typeof input !== "object" || input === null) {
    throw new Error("extraction: expected object");
  }
  const v = input as Record<string, unknown>;

  const requireDefined = (k: string) => {
    if (v[k] === undefined) throw new Error(`extraction: required field "${k}" missing`);
  };
  for (const k of ["is_real_mission", "remote", "client_type", "score", "reason"]) {
    requireDefined(k);
  }

  if (typeof v.is_real_mission !== "boolean") {
    throw new Error("extraction: is_real_mission must be boolean");
  }
  if (typeof v.score !== "number" || !Number.isInteger(v.score) || v.score < 0 || v.score > 100) {
    throw new Error("extraction: score must be integer 0..100");
  }
  if (typeof v.reason !== "string") {
    throw new Error("extraction: reason must be string");
  }
  if (!REMOTE_VALUES.includes(v.remote as Remote)) {
    throw new Error(`extraction: remote must be one of ${REMOTE_VALUES.join("|")}`);
  }
  if (!CLIENT_VALUES.includes(v.client_type as ClientType)) {
    throw new Error(`extraction: client_type must be one of ${CLIENT_VALUES.join("|")}`);
  }

  const rate =
    v.rate_eur_per_day === undefined || v.rate_eur_per_day === null
      ? null
      : Number(v.rate_eur_per_day);
  if (rate !== null && (!Number.isFinite(rate) || !Number.isInteger(rate) || rate < 0)) {
    throw new Error("extraction: rate_eur_per_day must be a non-negative integer or null");
  }

  return {
    is_real_mission: v.is_real_mission,
    rate_eur_per_day: rate,
    duration:
      v.duration === undefined || v.duration === null ? null : String(v.duration),
    remote: v.remote as Remote,
    location:
      v.location === undefined || v.location === null ? null : String(v.location),
    skills: Array.isArray(v.skills)
      ? v.skills.filter((s): s is string => typeof s === "string")
      : [],
    client_type: v.client_type as ClientType,
    score: v.score,
    reason: v.reason,
  };
}
