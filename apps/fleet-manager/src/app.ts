import { Hono } from "hono";
import type { AppEnv } from "./types";
import { fail } from "./lib/http";
import { createCorrelationContext, createStageLogger } from "@tutorbot/shared/observability";
import { botsRoutes } from "./modules/bots/routes";
import { gatewaysRoutes } from "./modules/gateways/routes";
import { personasRoutes } from "./modules/personas/routes";
import { monitorRoutes } from "./modules/monitor/routes";
import { uiRoutes } from "./modules/ui/routes";
import { docsRoutes } from "./modules/docs/routes";

const HELP = [
  "Fleet-Manager — control plane for the bot fleet (D1 registry + BotFleetDO)",
  "",
  "  POST   /bots            { botId?, gatewayId, personaName?, runMinutes?, force? }  provision + start (botId auto = bot-N)",
  "  GET    /bots            list registry (?live=1 => include DO stats)",
  "  GET    /bots/:id        one row + live stats",
  "  PATCH  /bots/:id        { gatewayId?, personaName? }  update mapping (running: gateway-only => live swap; persona => force-restart)",
  "  POST   /bots/:id/stop   stop the bot",
  "  POST   /bots/:id/restart  force a fresh run of a RUNNING bot (current mapping; cursor/counters reset)",
  "  DELETE /bots/:id        stop + remove from registry",
  "  POST   /gateways        { gatewayId?, label? }  provision a gateway (gatewayId auto = gw-N)",
  "  GET    /gateways        list the gateway roster (D1 source of truth)",
  "  GET    /gateways/:id    one gateway row",
  "  DELETE /gateways/:id    reap a gateway (blocked if bots pinned unless ?force=1)",
  "  GET    /personas        discover the persona catalog (for bot -> persona assignment)",
  "  GET    /monitor         fleet outbox health (all bots) — Monitoring tab",
  "  GET    /monitor/bots/:id/messages  one bot's chat log — Logs tab",
  "  GET    /ui              web control panel (provision + monitoring + logs)",
  "",
].join("\n");

/** Build the Hono app: request-id/access log, /bots module, help, error mappers. */
export function createApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // Per-request correlation + request-scoped logger + one structured access log.
  // Purely additive observability: it derives a correlation id (honouring an
  // inbound x-request-id, else a fresh UUID), stashes a logger on the context for
  // handlers, and logs once after the response — it never touches the response
  // body, status, or headers.
  app.use("*", async (c, next) => {
    const correlation = createCorrelationContext(c.req.raw);
    const log = createStageLogger({ context: { svc: "fleet-manager" }, correlation });
    c.set("correlation", correlation);
    c.set("requestId", correlation.request_id);
    c.set("log", log);

    const t0 = Date.now();
    const path = new URL(c.req.url).pathname;
    await next();
    log.info("http.request", `${c.req.method} ${path}`, {
      method: c.req.method,
      path,
      status: c.res.status,
      durationMs: Date.now() - t0,
    });
  });

  app.route("/bots", botsRoutes);
  app.route("/gateways", gatewaysRoutes);
  app.route("/personas", personasRoutes);
  app.route("/monitor", monitorRoutes);
  app.route("/ui", uiRoutes);
  // OpenAPI spec (/openapi.yaml) + Scalar UI (/docs).
  app.route("/", docsRoutes);

  app.get("/", (c) => c.text(HELP));

  app.notFound((c) => fail(c, 404, "not found"));

  app.onError((err, c) => {
    const log = c.get("log");
    if (log) log.error("http.error", err.message, { name: err.name });
    else console.error(JSON.stringify({ level: "error", stage: "http.error", message: err.message }));
    return fail(c, 500, err.message);
  });

  return app;
}
