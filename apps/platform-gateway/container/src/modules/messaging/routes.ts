import { Hono } from "hono";

import { DB_DSN_FIELD } from "@tutorbot/shared";
import { createCorrelationContext, createStageLogger } from "@tutorbot/shared/observability";
import type { ContainerBindings } from "../system/contracts.js";
import { OutboundService } from "../messaging-connections/outbound.js";
import { connectionRegistry } from "../messaging-connections/state.js";
import { stampChannelMessageId } from "./store.js";

/**
 * Container-side OUTBOUND message plane. The Worker routes a gatewayId to THIS
 * container (by name) and forwards a bot's reply here; the container SENDS it over
 * the bot's live MTProto socket and STAMPS the returned real channel message id
 * onto the reply row in Postgres over its own pg.Pool.
 *
 * INBOUND is NOT an HTTP route: real DMs arrive on the live socket and are
 * persisted directly by the messaging-connections service (socket -> domain filter
 * -> Postgres), so there is no POST /inbound here.
 */
export function createMessagingRouter() {
  const router = new Hono<{ Bindings: ContainerBindings }>();

  // Deliver: the bot's generated reply, routed here by the Worker. The container
  // is the channel edge: it SENDS over the bot's LIVE MTProto socket, then STAMPS
  // the returned real id onto the bot's reply row in Postgres — the gateway-side
  // "delivered" truth the bot-fleet drainer polls (channel_message_id IS NULL ==
  // not yet delivered).
  //
  // The destination is ENCODED in the reply key (parseReplyKey), so the send is
  // routed without the bot-fleet naming a chat — which is why the key is required.
  //
  // EFFECTIVELY-ONCE: OutboundService derives a STABLE MTProto random_id from the
  // (re-drive-stable) reply key and invokes the low-level Api.messages.SendMessage
  // with it, so a re-drive AFTER a successful send but FAILED stamp is
  // DE-DUPLICATED by Telegram (same random_id -> same message, no second DM). Two
  // layers compose: random_id de-dupes the WIRE send (server-side, time-bounded
  // window); the channel_message_id IS NULL stamp de-dupes the Postgres ROW (forever).
  router.post("/deliver", async (c) => {
    const correlation = createCorrelationContext(c.req.raw);
    const body = (await c.req.json().catch(() => null)) as
      | { botId?: unknown; content?: unknown; idempotencyKey?: unknown }
      | null;

    const botId = typeof body?.botId === "string" ? body.botId.trim() : "";
    const content = typeof body?.content === "string" ? body.content : "";
    const idempotencyKey =
      typeof body?.idempotencyKey === "string" ? body.idempotencyKey.trim() : "";

    const context: Record<string, unknown> = { svc: "gw-container" };
    if (botId) context.botId = botId;
    const log = createStageLogger({ context, correlation });

    if (!botId || !content) {
      log.warn("deliver.send", "rejected deliver with missing fields", { reason: "missing_fields" });
      return c.json({ ok: false, error: "botId and content are required" }, 400);
    }

    // The reply key drives BOTH the send routing (destination chatId is encoded in
    // it) and the exactly-once dedup + Postgres stamp, so it is required. bot-fleet
    // always sends it; a request without it cannot be delivered.
    if (!idempotencyKey) {
      log.warn("deliver.send", "rejected deliver with no idempotency key", { reason: "missing_key" });
      return c.json({ ok: false, error: "idempotencyKey is required" }, 400);
    }

    const mlog = log.child({ idempotencyKey });

    // Option B (body transport): DSN from the request BODY field the Worker injected
    // (Secrets Store), NOT a header — headers leak into invocation logs.
    const dsnRaw = (body as Record<string, unknown> | null)?.[DB_DSN_FIELD];
    const dsn = typeof dsnRaw === "string" ? dsnRaw : "";

    const outbound = new OutboundService({
      registry: connectionRegistry,
      stamp: stampChannelMessageId,
    });

    try {
      const res = await outbound.sendReply(botId, idempotencyKey, content, dsn);
      switch (res.kind) {
        case "not_connected":
          // No live socket yet (never connected / lost on restart). 503 => the
          // bot-fleet retry track re-drives once connect/recover has run.
          mlog.warn("deliver.send", "no live connection for bot (retryable)", {
            reason: "not_connected",
          });
          return c.json({ ok: false, error: "bot not connected" }, 503);
        case "send_failed":
          mlog.warn("deliver.send", "telegram send failed (retryable)", { error: res.error });
          return c.json({ ok: false, error: res.error }, 503);
        case "sent":
          mlog.info(
            "deliver.send",
            res.duplicate ? "delivery deduped (already stamped)" : "reply delivered and stamped",
            { channelMessageId: res.channelMessageId, duplicate: res.duplicate },
          );
          return c.json({
            ok: true,
            botId,
            channelMessageId: res.channelMessageId,
            duplicate: res.duplicate,
          });
      }
    } catch (e) {
      // The stamp threw (real DB error): the send already went out, but the
      // delivered-truth write failed. 500 => bot-fleet retries (see AT-LEAST-ONCE).
      const error = e instanceof Error ? e.message : String(e);
      mlog.error("db.error", "stamp channel_message_id failed", { op: "stamp_delivered", error }); // no DSN
      return c.json({ ok: false, error }, 500);
    }
  });

  return router;
}
