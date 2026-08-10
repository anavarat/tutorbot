import { Hono } from "hono";

import type { WorkerBindings } from "./modules/system/contracts.js";
import { createSystemRouter } from "./modules/system/routes.js";
import { createGatewayRouter } from "./modules/gateway/routes.js";
import { createDocsRouter } from "./modules/docs/routes.js";

export function createApp() {
  const app = new Hono<{ Bindings: WorkerBindings }>();

  // OpenAPI spec (/openapi.yaml) + Scalar UI (/docs).
  app.route("/", createDocsRouter());
  app.route("/", createGatewayRouter());
  app.route("/", createSystemRouter());

  return app;
}
