import { Hono } from "hono";
import type { AppEnv } from "../../types";
import { OPENAPI_SPEC } from "./spec";

/**
 * Serves the fleet-manager OpenAPI spec + a Scalar API-reference UI. Mirrors the
 * platform-gateway docs router: the spec is bundled as the TS const OPENAPI_SPEC
 * (a Worker cannot read a file from disk) and the UI is Scalar from a CDN.
 *
 *   GET /openapi.yaml  raw spec (text/yaml)
 *   GET /docs          Scalar API reference UI
 */
export const docsRoutes = new Hono<AppEnv>();

docsRoutes.get("/openapi.yaml", (c) =>
  c.text(OPENAPI_SPEC, 200, {
    "Content-Type": "text/yaml; charset=utf-8",
    "Cache-Control": "public, max-age=300",
  }),
);

docsRoutes.get("/docs", (c) =>
  c.html(`<!DOCTYPE html>
<html>
<head>
  <title>fleet-manager API</title>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
</head>
<body>
  <script id="api-reference" data-url="/openapi.yaml"></script>
  <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
</body>
</html>`),
);
