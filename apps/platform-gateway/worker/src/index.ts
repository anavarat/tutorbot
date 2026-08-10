import { ContainerProxy } from "@cloudflare/containers";

import { createApp } from "./app.js";
import type { WorkerBindings } from "./modules/system/contracts.js";

export { GatewayContainer } from "./durable-objects/GatewayContainer.js";
export { ContainerProxy };

export const app = createApp();

export default {
  fetch(request: Request, env: WorkerBindings, executionCtx?: unknown): Response | Promise<Response> {
    return app.fetch(request, env, executionCtx as never);
  },
};
