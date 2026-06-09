import type { Env } from "../types/env";
import {
  DIGEST_GIVE_UP_AFTER,
  DIGEST_TOP_N,
  DIGEST_VALIDATION_POOL,
} from "../config";
import { renderDigest } from "../email/digest";
import { createResendClient, type EmailLike } from "../email/resend";
import { recordRun } from "../store/db";
import {
  getTopUnnotifiedMissions,
  incrementValidationFails,
  markNotified,
  resetValidationFails,
  type MissionRow,
} from "../store/missions";
import { createLinkValidator, type LinkValidator } from "./linkHealth";

export interface DigestTickOptions {
  email?: EmailLike;
  validator?: LinkValidator;
  now?: Date;
}

export interface DigestTickResult {
  candidates: number; // number of working links actually put in the email
  sent: boolean;
  skipped: boolean;
}

/**
 * Daily digest: over-select a pool of un-notified real missions, validate each
 * link, ship the top-N healthy ones, and retire links that have failed
 * DIGEST_GIVE_UP_AFTER days running. Send-then-mark = at-least-once. Never throws
 * to the scheduler; failures land in the `runs` audit trail and roll to the next day.
 */
export async function runDigestTick(
  env: Env,
  opts: DigestTickOptions = {},
): Promise<DigestTickResult> {
  const email = opts.email ?? createResendClient(env.RESEND_API_KEY);
  const validator = opts.validator ?? createLinkValidator();
  const now = opts.now ?? new Date();
  const startedAt = now.toISOString();

  let candidates = 0;
  let sent = false;
  let skipped = false;
  let pool = 0;
  let dropped = 0;
  let gaveUp = 0;

  try {
    const rows = await getTopUnnotifiedMissions(env.DB, {
      limit: DIGEST_VALIDATION_POOL,
    });
    pool = rows.length;

    if (pool === 0) {
      skipped = true;
      return { candidates: 0, sent: false, skipped: true };
    }

    // Validate every pooled link concurrently. Worst case is 2×pool+1 subrequests
    // (each link can HEAD then fall back to GET, plus the Resend send) — still well
    // under the Workers per-invocation limit.
    const checks = await Promise.all(
      rows.map((m) => validator.check(m.url, m.source)),
    );
    const passed: MissionRow[] = [];
    const failed: MissionRow[] = [];
    rows.forEach((m, i) => {
      const r = checks[i];
      if (r.ok) {
        passed.push(m);
      } else {
        failed.push(m);
        console.warn("digest: dropping unhealthy link", {
          url: m.url,
          status: r.status,
          redirectedTo: r.redirectedTo,
        });
      }
    });
    dropped = failed.length;

    const toSend = passed.slice(0, DIGEST_TOP_N);
    candidates = toSend.length;

    // Persist validation state -- unconditional, so dead links are retired even on
    // a day when nothing ships.
    const giveUpIds = failed
      .filter((m) => m.validationFails + 1 >= DIGEST_GIVE_UP_AFTER)
      .map((m) => m.id);
    gaveUp = giveUpIds.length;
    // Reset every link that passed today -- the counter tracks consecutive LINK
    // failures, not email delivery, so a healthy check clears the streak even for
    // missions that go on to send (or whose send later throws).
    const recoveredIds = passed
      .filter((m) => m.validationFails > 0)
      .map((m) => m.id);

    await incrementValidationFails(env.DB, failed.map((m) => m.id));
    await resetValidationFails(env.DB, recoveredIds);
    await markNotified(env.DB, giveUpIds); // retire dead links regardless of send

    if (toSend.length === 0) {
      skipped = true;
      return { candidates: 0, sent: false, skipped: true };
    }

    const { subject, html, text } = renderDigest(toSend, { now });
    await email.send({
      from: env.DIGEST_FROM,
      to: env.DIGEST_TO,
      subject,
      html,
      text,
    });
    sent = true;
    await markNotified(env.DB, toSend.map((m) => m.id));
    return { candidates, sent: true, skipped: false };
  } catch (err) {
    // `sent` discriminates pre-send failures from a rare post-send markNotified throw.
    console.error("digest tick failed (sent=%s):", sent, String(err));
    return { candidates, sent, skipped };
  } finally {
    await recordRun(env.DB, {
      tick: "digest",
      startedAt,
      finishedAt: new Date().toISOString(),
      stats: { candidates, sent, skipped, pool, dropped, gaveUp },
    });
  }
}
