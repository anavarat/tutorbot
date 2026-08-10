import { Hono } from "hono";

import type { ContainerBindings } from "../system/contracts.js";
import { handleConnect, handleConnections, handleDisconnect } from "./controller.js";

/**
 * Connection / client lifecycle for the container's Telegram plane (bounded
 * context: messaging-connections). The Worker routes a gatewayId to THIS
 * container and forwards here; the container owns the long-lived MTProto socket.
 *
 * /connection/connect (manual / dev-triggered — connect one bot from a
 * pre-minted StringSession, prove getMe). /connection/recover (cold-start rebuild
 * from Postgres via recoverSession()) lands in.
 */
export function createMessagingConnectionsRouter() {
  const router = new Hono<{ Bindings: ContainerBindings }>();

  router.post("/connection/connect", (c) => handleConnect(c));
  router.post("/connection/disconnect", (c) => handleDisconnect(c));
  router.get("/connections", (c) => handleConnections(c));

  return router;
}
