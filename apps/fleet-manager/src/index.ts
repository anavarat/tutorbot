/**
 * fleet-manager — stateless control-plane Worker (Hono entry point).
 *
 * Routes/behaviour are defined in app.ts + modules/bots/*. This file constructs
 * the app and exports the Worker handlers:
 *   - fetch:     the Hono app (Workers-compatible fetch(request, env, ctx)).
 *   - scheduled: the cron reconcile sweeps (stuck reassignment sagas + dead
 *                sockets). Cron triggers are declared per-env in wrangler.jsonc.
 */
import { createApp } from "./app";
import { runScheduled } from "./scheduled";

const app = createApp();

export default {
  fetch: app.fetch,
  scheduled: runScheduled,
};
