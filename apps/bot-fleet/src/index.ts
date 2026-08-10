/**
 * bot-fleet — DATA PLANE. This Worker's only jobs are to:
 *   1. define + host the BotFleetDO class (see the `migrations` block in
 *      wrangler.jsonc — this Worker OWNS the DO class), and
 *   2. offer a worker-level DB sanity check that never touches a DO.
 *
 * Provisioning / listing / stopping bots is owned by the fleet-manager Worker
 * (D1 registry). fleet-manager drives bot lifecycle over its BOT_FLEET service
 * binding by calling this Worker's HTTP control routes (POST /bots/:id/start etc.,
 * see control-routes.ts); THIS Worker then resolves the per-bot DO by name and
 * invokes its native start()/reconfigure()/stop()/stats() method (defined in
 * durable-objects/bot-fleet-do/*). The DO RPC is now an internal, same-worker call.
 */
import { BotFleetDO } from "./durable-objects/bot-fleet-do/bot-fleet-do";
import { createApp } from "./app";

// Wrangler needs the class exported here (the DO binding + migrations name it).
export { BotFleetDO };

// Hono app provides the Worker's fetch() handler.
export default createApp();
