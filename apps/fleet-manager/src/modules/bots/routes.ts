import { Hono } from "hono";
import type { AppEnv } from "../../types";
import { fail } from "../../lib/http";
import * as bots from "./controller";

/**
 * /bots router (mounted at "/bots" in app.ts). Handlers return a Response, so
 * the first method-match wins; the trailing `.all(...)` on each path catches
 * every other method and returns 405 — preserving the earlier explicit
 * "method not allowed" behaviour (Hono would otherwise fall through to 404).
 */
export const botsRoutes = new Hono<AppEnv>();

botsRoutes.get("/", (c) => bots.list(c));
botsRoutes.post("/", (c) => bots.provision(c));
botsRoutes.all("/", (c) => fail(c, 405, "method not allowed"));

botsRoutes.get("/:id", (c) => bots.getOne(c));
botsRoutes.patch("/:id", (c) => bots.updateConfig(c));
botsRoutes.delete("/:id", (c) => bots.remove(c));
botsRoutes.all("/:id", (c) => fail(c, 405, "method not allowed"));

botsRoutes.post("/:id/stop", (c) => bots.stop(c));
botsRoutes.all("/:id/stop", (c) => fail(c, 405, "method not allowed"));

botsRoutes.post("/:id/restart", (c) => bots.restart(c));
botsRoutes.all("/:id/restart", (c) => fail(c, 405, "method not allowed"));
