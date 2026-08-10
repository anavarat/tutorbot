import { Hono } from "hono";
import type { AppEnv } from "../../types";
import { fail } from "../../lib/http";
import * as gateways from "./controller";

/**
 * /gateways router (mounted at "/gateways" in app.ts). Gateways are a first-class
 * fleet entity backed by FM's D1 `gateways` table (0004) — FM is the source of
 * truth for "which gateways exist", NOT the GW Worker's old GATEWAY_IDS var.
 *
 * Mirrors /bots: handlers return a Response so the first method-match wins; the
 * trailing `.all(...)` on each path returns 405 for other methods.
 *
 *   POST   /gateways        { gatewayId?, label? }  provision (gatewayId auto = gw-N)
 *   GET    /gateways        list the roster (rows)
 *   GET    /gateways/:id    one gateway row
 *   GET    /gateways/:id/roster  cold-start recovery roster (INTERNAL)
 *   DELETE /gateways/:id    reap (refused if bots pinned unless ?force=1)
 */
export const gatewaysRoutes = new Hono<AppEnv>();

gatewaysRoutes.get("/", (c) => gateways.list(c));
gatewaysRoutes.post("/", (c) => gateways.provision(c));
gatewaysRoutes.all("/", (c) => fail(c, 405, "method not allowed"));

// Cold-start recovery roster (Pull). Two-segment path, so it never
// collides with the "/:id" group below. Internal-only (GW onStart via binding).
gatewaysRoutes.get("/:id/roster", (c) => gateways.roster(c));
gatewaysRoutes.all("/:id/roster", (c) => fail(c, 405, "method not allowed"));

gatewaysRoutes.get("/:id", (c) => gateways.getOne(c));
gatewaysRoutes.delete("/:id", (c) => gateways.reap(c));
gatewaysRoutes.all("/:id", (c) => fail(c, 405, "method not allowed"));
