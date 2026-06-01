import type { Env } from "../types/env";
import { DIGEST_MAX_ITEMS, DIGEST_MIN_SCORE } from "../config";
import { renderDigest } from "../email/digest";
import { createResendClient, type EmailLike } from "../email/resend";
import { recordRun } from "../store/db";
import { getUnnotifiedMissions, markNotified } from "../store/missions";

export interface DigestTickOptions {
  email?: EmailLike;
  now?: Date;
}

export interface DigestTickResult {
  candidates: number;
  sent: boolean;
  skipped: boolean;
}

/**
 * Daily digest: select un-notified real missions ≥ DIGEST_MIN_SCORE, email them,
 * then mark them notified (send-then-mark = at-least-once). Never throws to the
 * scheduler; failures land in the `runs` audit trail and roll to the next day.
 */
export async function runDigestTick(
  env: Env,
  opts: DigestTickOptions = {},
): Promise<DigestTickResult> {
  const email = opts.email ?? createResendClient(env.RESEND_API_KEY);
  const now = opts.now ?? new Date();
  const startedAt = now.toISOString();

  let candidates = 0;
  let sent = false;
  let skipped = false;

  try {
    const rows = await getUnnotifiedMissions(env.DB, {
      minScore: DIGEST_MIN_SCORE,
      limit: DIGEST_MAX_ITEMS,
    });
    candidates = rows.length;

    if (candidates === 0) {
      skipped = true;
      return { candidates: 0, sent: false, skipped: true };
    }

    const { subject, html, text } = renderDigest(rows, {
      now,
      minScore: DIGEST_MIN_SCORE,
    });
    await email.send({ from: env.DIGEST_FROM, to: env.DIGEST_TO, subject, html, text });
    sent = true;
    await markNotified(env.DB, rows.map((r) => r.id));
    return { candidates, sent: true, skipped: false };
  } catch (err) {
    // `sent` discriminates pre-send failures (select/render/send) from a rare
    // post-send failure (markNotified threw) — useful when triaging the logs.
    console.error("digest tick failed (sent=%s):", sent, String(err));
    return { candidates, sent, skipped };
  } finally {
    // sent=true means the email was delivered; the missions' `notified` flags
    // may still be 0 if markNotified threw after the send (at-least-once — they
    // re-send tomorrow). The audit stays honest: it records the send happened.
    await recordRun(env.DB, {
      tick: "digest",
      startedAt,
      finishedAt: new Date().toISOString(),
      stats: { candidates, sent, skipped },
    });
  }
}
