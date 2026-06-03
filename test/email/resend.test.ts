import { describe, expect, it, vi } from "vitest";
import { createResendClient, type EmailMessage } from "../../src/email/resend";

const msg: EmailMessage = {
  from: "digest@example.com",
  to: "owner@example.com",
  subject: "s",
  html: "<p>h</p>",
  text: "h",
};

describe("email/resend", () => {
  it("POSTs to the Resend API with bearer auth and a JSON body", async () => {
    const fetchImpl = vi.fn(
      async (_url: string, _init: RequestInit) =>
        new Response(JSON.stringify({ id: "1" }), { status: 200 }),
    );
    await createResendClient("key_123", fetchImpl as unknown as typeof fetch).send(
      msg,
    );

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer key_123");
    expect(headers["content-type"]).toContain("application/json");
    const sent = JSON.parse(init.body as string);
    expect(sent).toMatchObject({
      from: "digest@example.com",
      to: ["owner@example.com"],
      subject: "s",
    });
  });

  it("throws on a non-2xx response", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 422 }));
    await expect(
      createResendClient("k", fetchImpl as unknown as typeof fetch).send(msg),
    ).rejects.toThrow(/422/);
  });

  it("resolves on a 2xx response", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 200 }));
    await expect(
      createResendClient("k", fetchImpl as unknown as typeof fetch).send(msg),
    ).resolves.toBeUndefined();
  });

  it("never leaks the API key in the thrown error", async () => {
    const apiKey = "key_super_secret_123";
    const fetchImpl = vi.fn(async () => new Response("unauthorized", { status: 401 }));
    const err = (await createResendClient(apiKey, fetchImpl as unknown as typeof fetch)
      .send(msg)
      .catch((e) => e)) as Error;
    expect(err.message).toMatch(/401/);
    expect(err.message).not.toContain(apiKey);
  });
});
