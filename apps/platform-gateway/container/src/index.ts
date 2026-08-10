import { serve } from "@hono/node-server";

import { createApp } from "./app.js";
import { createStageLogger } from "@tutorbot/shared/observability";
import { logContainerStartup, registerSigtermHandler } from "./modules/system/lifecycle.js";
import type { ContainerBindings } from "./modules/system/contracts.js";
import { connectionRegistry } from "./modules/messaging-connections/state.js";

const PORT = Number(process.env.PORT ?? 8080);

// Hard cap on the graceful MTProto drain so shutdown can never hang past the
// platform's SIGKILL grace window.
const DRAIN_TIMEOUT_MS = 5_000;

function getContainerBindings(): ContainerBindings {
  // Deliberately does NOT include the DB connection string / password — this
  // object is logged at startup, so the secret must never be placed here.
  return {
    APP_ENV: process.env.APP_ENV,
    APP_VERSION: process.env.APP_VERSION,
  };
}

const app = createApp();
const bindings = getContainerBindings();
// Process-level logger: startup/sigterm are not request-scoped, so no
// correlation id — just the base service context. Sink defaults to console
// (container stdout stream).
const log = createStageLogger({ context: { svc: "gw-container" } });

logContainerStartup(log, bindings);

const server = serve({
  fetch: app.fetch,
  port: PORT,
});

/**
 * Cleanly close every live MTProto socket BEFORE the process exits. Telegram
 * allows only ONE live connection per auth_key; if this instance dies without
 * disconnecting (e.g. a redeploy / container re-placement / gradual rollout where
 * the next instance connects the same session), Telegram still sees the old
 * connection alive and rejects the new one with 406 AUTH_KEY_DUPLICATED. Sending
 * a real disconnect here frees each auth_key so the successor can reconnect.
 * Best-effort + time-boxed: a stuck socket must not block shutdown.
 */
async function drainConnections(): Promise<void> {
  const ids = connectionRegistry.ids();
  if (ids.length === 0) return;
  log.info("lifecycle.drain", "disconnecting live MTProto sockets before exit", { count: ids.length });
  const drains = ids.map(async (id) => {
    const conn = connectionRegistry.get(id);
    if (!conn) return;
    await conn.client.disconnect().catch((e) => {
      log.warn("lifecycle.drain", "socket close failed during shutdown drain (auth_key may not free until reap)", {
        botId: id,
        error: e instanceof Error ? e.message : String(e),
      });
    });
    connectionRegistry.delete(id);
  });
  await Promise.race([
    Promise.allSettled(drains),
    new Promise<void>((resolve) => setTimeout(resolve, DRAIN_TIMEOUT_MS)),
  ]);
}

registerSigtermHandler(process, log, () => {
  void (async () => {
    // Stop accepting new HTTP (so no fresh connects open during the drain), then
    // free the Telegram auth_keys, then exit.
    server.close();
    await drainConnections();
    process.exit(0);
  })();
  // Safety net: force-exit if close/drain wedges past the grace window.
  setTimeout(() => process.exit(0), DRAIN_TIMEOUT_MS + 2_000).unref();
});
