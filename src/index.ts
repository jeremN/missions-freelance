import type { Env } from "./types/env";
import { handleApi } from "./http/api";
import { runFetchTick } from "./pipeline/fetchTick";

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
