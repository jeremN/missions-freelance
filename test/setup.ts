import { applyD1Migrations, env } from "cloudflare:test";

// Apply D1 migrations to the isolated local DB once before the test suite.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
