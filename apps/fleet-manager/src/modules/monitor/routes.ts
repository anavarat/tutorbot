import { Hono } from "hono";
import type { AppEnv } from "../../types";
import { fail } from "../../lib/http";
import { fleetOutboxHealth, botChatLog } from "../../platform/hyperdrive/message-repo";

/**
 * /monitor router (mounted at "/monitor"): READ-ONLY observability for the /ui
 * Monitoring + Logs tabs. Both handlers read the shared `message` table directly
 * via FM's HYPERDRIVE binding (see message-repo). Kept under its own namespace so
 * the per-bot log path (/monitor/bots/:id/messages) never collides with the
 * control-plane /bots/:id routes.
 *
 *   GET /monitor                     fleet-wide outbox health map (all bots)
 *   GET /monitor/bots/:id/messages   one bot's chat log (?limit=, default 200, max 1000)
 *
 * These are the DERIVED half of the traffic lights (bot -> gateway "last send"):
 * observed, non-authoritative signal assembled from delivery state. The live
 * gateway -> platform socket probe is intentionally NOT here yet;
 * the UI shows that light as "unknown (not probed)".
 */
export const monitorRoutes = new Hono<AppEnv>();

monitorRoutes.get("/", async (c) => {
  const health = await fleetOutboxHealth(c.env.HYPERDRIVE.connectionString);
  return c.json({ ok: true, health }, 200);
});
monitorRoutes.all("/", (c) => fail(c, 405, "method not allowed"));

monitorRoutes.get("/bots/:id/messages", async (c) => {
  const botId = c.req.param("id")!;
  const raw = Number(c.req.query("limit"));
  const limit = Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), 1000) : 200;
  const messages = await botChatLog(c.env.HYPERDRIVE.connectionString, botId, limit);
  return c.json({ ok: true, botId, messages }, 200);
});
monitorRoutes.all("/bots/:id/messages", (c) => fail(c, 405, "method not allowed"));
