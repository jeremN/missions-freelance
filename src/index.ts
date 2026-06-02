import type { Env } from "./types/env";
import { handleApi } from "./http/api";
import { runFetchTick } from "./pipeline/fetchTick";
import { runScoreTick } from "./pipeline/scoreTick";
import { runDigestTick } from "./pipeline/digestTick";

export default {
  async scheduled(
    controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    switch (controller.cron) {
      case "*/30 * * * *":
        ctx.waitUntil(runFetchTick(env));
        break;
      case "*/15 * * * *":
        ctx.waitUntil(runScoreTick(env));
        break;
      case "0 5 * * *":
        ctx.waitUntil(runDigestTick(env));
        break;
      default:
        console.warn(`unhandled cron: ${controller.cron}`);
    }
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const apiResponse = await handleApi(request, env);
    if (apiResponse) return apiResponse;
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
