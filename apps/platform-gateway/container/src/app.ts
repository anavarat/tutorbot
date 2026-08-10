import { Hono } from "hono";

import type { ContainerBindings } from "./modules/system/contracts.js";
import { createSystemRouter } from "./modules/system/routes.js";
import { createMessagingRouter } from "./modules/messaging/routes.js";
import { createMessagingConnectionsRouter } from "./modules/messaging-connections/routes.js";
import { createDocsRouter } from "./modules/docs/routes.js";

export function createApp() {
  const app = new Hono<{ Bindings: ContainerBindings }>();

  // OpenAPI spec (/openapi.yaml) + Scalar UI (/docs). Internal-only surface.
  app.route("/", createDocsRouter());
  app.route("/", createMessagingRouter());
  // Telegram connection/client lifecycle (/connection/connect, …) — the stateful plane.
  app.route("/", createMessagingConnectionsRouter());
  app.route("/", createSystemRouter());

  return app;
}
