# missions-free

missions-free was a freelance-mission scanner. It ran on Cloudflare Workers, D1, and Workers AI. It pulled mission posts from several sources, scored them, and sent a daily digest by email.

On 2026-08-25, this repo dropped the D1 database, the Workers AI scoring, and the email pipeline. The reason: Cloudflare started to enforce D1's free-tier daily row limits, and the project no longer needed a database. The Worker now serves only the static dashboard in `public/`.

## Current state

The Worker has one handler, `fetch()`. It returns the assets in `public/`.

There is no database, no AI scoring, no cron trigger, and no email digest.

## Local development

```bash
npm install   # regenerates worker-configuration.d.ts
npm run dev   # starts wrangler dev
npm test      # runs the test suite (currently empty)
```

## Deploy

```bash
npm run deploy
```

## Tech stack

- **Runtime:** Cloudflare Workers
- **Static assets:** Workers Assets (`public/`)
- **Language:** TypeScript (strict)
- **Tests:** Vitest + `@cloudflare/vitest-pool-workers`

## Conventions

- **Commits:** one short conventional-commits subject line. No body.
- **Hooks:** run normally. Do not use `--no-verify`.

## License

This is a personal project. No license is declared. Open an issue before you reuse a piece.
