import type { Env as AppEnv } from "../src/types/env";
import type { D1Migration } from "cloudflare:test";

// cloudflare:test's `env` is typed as Cloudflare.Env. Extend it with the app's Env so
// the test `env` can be passed to the worker's Env-typed handlers, and add the
// TEST_MIGRATIONS binding injected by vitest.config.ts. Extending AppEnv keeps the
// binding/secret list single-sourced in src/types/env.ts (no drift).
declare global {
  namespace Cloudflare {
    interface Env extends AppEnv {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
