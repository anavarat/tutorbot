import { Hono } from "hono";
import type { BotFleetEnv } from "../types";
import { OPENAPI_SPEC } from "./spec";

/**
 * Serves the bot-fleet OpenAPI spec + a Scalar API-reference UI. Mirrors the
 * platform-gateway docs router: the spec is the TS const OPENAPI_SPEC (a Worker
 * cannot read a file from disk, so the YAML is bundled as a string), and the UI
 * is Scalar loaded from a CDN (no npm dependency added).
 *
 *   GET /openapi.yaml  raw spec (text/yaml)
 *   GET /docs          Scalar API reference UI (points at /openapi.yaml)
 */
export function createDocsRouter(): Hono<{ Bindings: BotFleetEnv }> {
  const router = new Hono<{ Bindings: BotFleetEnv }>();

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
  <title>bot-fleet API</title>
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
