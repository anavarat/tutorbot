import { Hono } from "hono";

import type { ContainerBindings } from "./contracts.js";
import { resolveContainerHealth } from "./contracts.js";

export function createSystemRouter() {
  const router = new Hono<{ Bindings: ContainerBindings }>();

  router.get("/health", (c) => c.json(resolveContainerHealth(c.env)));
  router.get("/ready", (c) => c.json(resolveContainerHealth(c.env)));

  return router;
}
