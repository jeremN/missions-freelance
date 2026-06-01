export interface EmailMessage {
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
}

/** What the digest pipeline needs from an email transport — narrowed so tests can fake it. */
export interface EmailLike {
  send(msg: EmailMessage): Promise<void>;
}

const RESEND_ENDPOINT = "https://api.resend.com/emails";

/**
 * Minimal Resend client (no SDK). `send` POSTs the message and THROWS on any
 * non-2xx response — the digest tick relies on that throw to avoid marking
 * missions `notified` when delivery failed.
 */
export function createResendClient(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): EmailLike {
  return {
    async send(msg: EmailMessage): Promise<void> {
      const res = await fetchImpl(RESEND_ENDPOINT, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          from: msg.from,
          to: [msg.to],
          subject: msg.subject,
          html: msg.html,
          text: msg.text,
        }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`resend send failed: ${res.status} ${body.slice(0, 200)}`);
      }
    },
  };
}
