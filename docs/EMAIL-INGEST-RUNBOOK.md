# Email-ingest runbook (LinkedIn job alerts → missions-free)

The Worker exposes an `email()` handler that ingests job-alert emails into the
candidate pipeline (source-agnostic; LinkedIn parser shipped). Wiring the inbound
address is a one-time infra setup.

## Prerequisites
- A domain (zone) on Cloudflare. Email Routing cannot receive on `*.workers.dev`.

## 1. Enable Email Routing + route an address to this Worker
- Dashboard → your domain → **Email Routing** → enable (adds MX/SPF records), OR
  `npx wrangler email routing enable`.
- Create a custom address, e.g. `missions@yourdomain.com`, action **Send to a Worker**
  → select the `missions-free` Worker. CLI equivalent:
  `npx wrangler email routing rules create --type send-to-worker --value missions-free missions@yourdomain.com`
  (verify exact flags with `npx wrangler email routing rules create --help`).

## 2. Forward LinkedIn alerts to that address (Proton)
LinkedIn sends alerts to your account inbox (jeremie.nehlil.freelance@proton.me).
In Proton: Settings → Filters → add a filter: **From contains `linkedin.com`**
(or `jobalerts-noreply@linkedin.com`) → **Forward to** `missions@yourdomain.com`.
Proton requires verifying the forward destination once (confirm the email it sends).

## 3. Create the LinkedIn alert
LinkedIn → Jobs → search with **Job type = Contract** + your keywords + location →
**Create job alert** → delivery **Email**, frequency **Daily**. (Optional: a 2nd alert.)

## 4. Verify
- Wait for / trigger an alert. Watch `npx wrangler tail` for `inbound email` logs and
  an `email` run, or check `/api/runs` (browser, behind Access) for a `tick:"email"` row
  with `inserted > 0`. New `source:"linkedin"` candidates appear in `/api/candidates`.

## Notes
- Only senders on the parser allow-list (`linkedin.com`) are ingested; others are
  logged and ignored (anti-spoof; `message.from` is the trustworthy envelope sender).
- The LinkedIn parser is best-effort (plain-text `/jobs/view/{id}` extraction). If titles
  look wrong, capture a real alert's plain-text part and refine `src/sources/email/linkedin.ts`.
- Adding another emailed source (e.g. Hellowork alerts) = add a parser to
  `src/sources/email/` and register it in `registry.ts`. No handler changes.
