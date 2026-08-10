import { workerPackage } from "@tutorbot/shared";
import { Hono } from "hono";

import type { WorkerBindings } from "./contracts.js";
import { resolveHealth } from "./contracts.js";
import { proxyContainerRequest } from "./containerProxy.js";

export function createSystemRouter() {
  const router = new Hono<{ Bindings: WorkerBindings }>();

  router.get("/health", (c) => c.json(resolveHealth(c.env)));
  router.get("/container/health", (c) => proxyContainerRequest(c.req.raw, c.env));
  router.get("/container/ready", (c) => proxyContainerRequest(c.req.raw, c.env));

  // Container API docs, exposed THROUGH the worker for dev/understanding. The raw
  // spec is proxied from the real (default) container; the viewer is worker-owned
  // HTML pointing Scalar at that proxied URL. We do NOT proxy the container's own
  // /docs HTML: its data-url="/openapi.yaml" is relative and would resolve to the
  // WORKER's spec. So: worker /docs = worker API, worker /container/docs = container API.
  router.get("/container/openapi.yaml", (c) => proxyContainerRequest(c.req.raw, c.env));
  router.get("/container/docs", (c) =>
    c.html(`<!DOCTYPE html>
<html>
<head>
  <title>platform-gateway (container) API</title>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
</head>
<body>
  <script id="api-reference" data-url="/container/openapi.yaml"></script>
  <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
</body>
</html>`),
  );
  router.get("/", (c) =>
    c.json({
      ok: false,
      component: workerPackage.name,
      message: "Use GET /health",
    }, 404),
  );

  return router;
}
