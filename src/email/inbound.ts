import PostalMime from "postal-mime";
import type { Env } from "../types/env";
import { profile as defaultProfile } from "../config";
import { selectCandidates } from "../pipeline/select";
import { insertCandidates, recordRun } from "../store/db";
import { parserForSender } from "../sources/email/registry";

/**
 * Inbound email → candidates. Source-agnostic: dispatch by the (trustworthy)
 * envelope sender to a per-source parser, then reuse the prefilter + insert path.
 * Unknown senders are ignored (raw consumed so the mail isn't dropped); never throws.
 */
export async function handleInboundEmail(
  message: ForwardableEmailMessage,
  env: Env,
): Promise<void> {
  const parser = parserForSender(message.from);
  if (!parser) {
    console.warn("inbound email: unknown sender, ignoring:", message.from);
    // Consume the stream so Email Routing treats the message as handled.
    await new Response(message.raw).arrayBuffer().catch(() => undefined);
    return;
  }

  const startedAt = new Date().toISOString();
  let parsed = 0;
  let inserted = 0;
  try {
    const raw = await new Response(message.raw).arrayBuffer();
    const email = await PostalMime.parse(raw);
    const missions = parser.parse({
      subject: email.subject,
      text: email.text,
      html: email.html ?? undefined,
    });
    parsed = missions.length;
    inserted = await insertCandidates(env.DB, selectCandidates(missions, defaultProfile));
  } catch (err) {
    console.error("inbound email: failed to process:", parser.id, err);
  } finally {
    // Guard the audit write too: a transient D1 failure here must not throw out
    // of the handler, or Email Routing would retry the (already-ingested) message.
    await recordRun(env.DB, {
      tick: "email",
      startedAt,
      finishedAt: new Date().toISOString(),
      stats: { source: parser.id, parsed, inserted },
    }).catch((err) =>
      console.error("inbound email: failed to record run:", parser.id, err),
    );
  }
}
