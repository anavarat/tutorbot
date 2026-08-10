import { Hono } from "hono";
import type { BotFleetEnv } from "./types";
import { countMessages } from "./platform/hyperdrive/message-repo";
import { createDocsRouter } from "./docs/routes";
import { createControlRouter } from "./control-routes";

const HELP = [
  "bot-fleet — data plane (hosts BotFleetDO). Provisioning is owned by fleet-manager.",
  "",
  "  GET  /ping-db                  worker-level Hyperdrive->Supabase check (no DO activeTime)",
  "  POST /bots/:botId/start        start a bot's poll loop        (fleet-manager control call)",
  "  POST /bots/:botId/reconfigure  live-swap a bot's gateway       (fleet-manager control call)",
  "  POST /bots/:botId/stop         stop a bot's poll loop          (fleet-manager control call)",
  "  GET  /bots/:botId/stats        a bot's live counters           (fleet-manager control call)",
  "",
].join("\n");

/** Build the data-plane Hono app. Only a DB sanity check; nothing here touches a DO. */
export function createApp(): Hono<{ Bindings: BotFleetEnv }> {
  const app = new Hono<{ Bindings: BotFleetEnv }>();

  // OpenAPI spec (/openapi.yaml) + Scalar UI (/docs). Registered before the
  // catch-all notFound so these explicit routes win over the help-text fallback.
  app.route("/", createDocsRouter());

  // Bot lifecycle control plane (fleet-manager calls these over its BOT_FLEET
  // service binding — HTTP, not cross-script DO RPC). Resolves each bot's DO by
  // name internally. See control-routes.ts.
  app.route("/", createControlRouter());

  // Method-agnostic, matching the earlier build (any method on /ping-db ran the check).
  app.all("/ping-db", async (c) => {
    try {
      const messages = await countMessages(c.env.HYPERDRIVE.connectionString);
      return c.json({ ok: true, messages });
    } catch (e) {
      return c.json({ ok: false, error: (e as Error).message }, 500);
    }
  });

  // Earlier behaviour: every other path/method returns the help text with 200
  // (bot-fleet never surfaced a 404). Preserved deliberately.
  app.notFound((c) => c.text(HELP));

  return app;
}
