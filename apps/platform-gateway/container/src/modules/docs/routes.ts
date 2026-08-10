import { Hono } from "hono";

import type { ContainerBindings } from "../system/contracts.js";
import { OPENAPI_SPEC } from "./spec.js";

/**
 * Serves the CONTAINER's internal OpenAPI spec + a Scalar API-reference UI. The
 * container runs on Node, but the spec is still bundled as the TS const
 * OPENAPI_SPEC for parity with the Worker docs routers. These routes are only
 * reachable inside the container (or via a dev exec); the spec's main value is
 * as a reviewable artifact and a curl-able /openapi.yaml.
 *
 *   GET /openapi.yaml  raw spec (text/yaml)
 *   GET /docs          Scalar API reference UI
 */
export function createDocsRouter() {
  const router = new Hono<{ Bindings: ContainerBindings }>();

  router.get("/openapi.yaml", (c) =>
    c.text(OPENAPI_SPEC, 200, {
      "Content-Type": "text/yaml; charset=utf-8",
      "Cache-Control": "public, max-age=300",
    }),
  );

  router.get("/docs", (c) =>
    c.html(`<!DOCTYPE html>
<html>
<head>
  <title>platform-gateway (container) API</title>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
</head>
<body>
  <script id="api-reference" data-url="/openapi.yaml"></script>
  <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
</body>
</html>`),
  );

  return router;
}
