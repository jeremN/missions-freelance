import { defineConfig } from "vitest/config";
import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    plugins: [
      cloudflareTest({
        // The `ai` binding always runs remotely, so the pool tries to open a
        // remote-proxy session to the deployed Worker at startup. That Worker is
        // behind Cloudflare Access, which blocks the (non-interactive) session and
        // prevents the whole pool from starting. No test uses the real `env.AI`
        // (scoring tests inject a fake `AiLike`), so disable remote bindings to
        // keep the pool fully local.
        remoteBindings: false,
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: { TEST_MIGRATIONS: migrations },
        },
      }),
    ],
    test: {
      setupFiles: ["./test/setup.ts"],
    },
  };
});
