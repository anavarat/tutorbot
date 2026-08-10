import type { Context } from "hono";

import { DB_DSN_FIELD } from "@tutorbot/shared";
import { createCorrelationContext, createStageLogger } from "@tutorbot/shared/observability";

import { TelegramClientAdapter } from "../../platform/telegram/client.js";
import { insertInboundMessage, readUpdateState, upsertUpdateState } from "../messaging/store.js";
import { connectRequestSchema, disconnectRequestSchema } from "./schema.js";
import { MessagingConnectionsService } from "./service.js";
import { connectionRegistry } from "./state.js";

/**
 * Resolve the MTProto creds for this connect: PER-BOT `apiId`/`apiHash` from the
 * request body win (anti-ban), else fall back to the app-level env
 * pair (dev/bootstrap; the Worker injects it via buildContainerEnv). NEVER read
 * from the ContainerBindings object (logged at startup) and NEVER logged here —
 * apiHash is a secret. In the per-bot pair arrives from the gateway DO's
 * provisioned credential triple.
 */
function resolveCreds(body: { apiId?: number; apiHash?: string }): { apiId: number; apiHash: string } | null {
  const apiId = body.apiId ?? Number(process.env.TELEGRAM_API_ID);
  const apiHash = body.apiHash ?? process.env.TELEGRAM_API_HASH ?? "";
  if (!apiId || !apiHash) {
    return null;
  }
  return { apiId, apiHash };
}

/**
 * POST /connection/connect — per-request DI wiring (bots/controller.ts pattern):
 * assemble the service from the injected ports (adapter connector, env creds, the
 * singleton registry), run it, map the `{ kind }` result to HTTP. The session
 * credential is never logged.
 */
export async function handleConnect(c: Context): Promise<Response> {
  const correlation = createCorrelationContext(c.req.raw);
  const raw = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;

  const parsed = connectRequestSchema.safeParse(raw);
  const context: Record<string, unknown> = { svc: "gw-container" };
  if (parsed.success) {
    context.botId = parsed.data.botId;
  }
  const log = createStageLogger({ context, correlation });

  if (!parsed.success) {
    log.warn("connection.connect", "rejected connect with invalid body", { reason: "invalid_body" });
    return c.json({ ok: false, error: "botId and sessionCredential are required" }, 400);
  }

  const creds = resolveCreds(parsed.data);
  if (!creds) {
    log.error("connection.connect", "no telegram creds (none in connect body, env fallback unset)", {
      reason: "missing_credentials",
    });
    return c.json(
      { ok: false, error: "telegram credentials not provided (per-bot in body or env fallback)" },
      500,
    );
  }

  //: cache the DSN the Worker injected (body transport) so a inbound socket
  // event can persist without an HTTP request carrying it. Unused in.
  const dsnRaw = raw?.[DB_DSN_FIELD];
  const dsn = typeof dsnRaw === "string" ? dsnRaw : "";

  const service = new MessagingConnectionsService({
    connect: TelegramClientAdapter.connect,
    creds,
    registry: connectionRegistry,
    persistInbound: insertInboundMessage,
    readUpdateState,
    persistUpdateState: upsertUpdateState,
  });

  const result = await service.connect(parsed.data.botId, parsed.data.sessionCredential, dsn);

  switch (result.kind) {
    case "connected":
      // Session credential NEVER logged; tg id/username are safe identifiers.
      log.info("connection.connect", "telegram client connected", {
        tgUserId: result.identity.id,
        username: result.identity.username,
      });
      return c.json({ ok: true, botId: parsed.data.botId, identity: result.identity });
    case "session_unauthorized":
      log.warn("connection.connect", "session no longer authorized (re-mint required)", {
        reason: "session_unauthorized",
      });
      return c.json({ ok: false, error: "session_unauthorized" }, 409);
    case "connect_failed":
      log.error("connection.connect", "telegram connect failed", { error: result.error });
      return c.json({ ok: false, error: result.error }, 502);
  }
}

/**
 * GET /connections — the live connection set: the botIds this container currently
 * holds an open MTProto socket for ( health probe). No secrets, no body;
 * FM's reconcile sweep diffs this against D1's RUNNING set to find dead sockets.
 */
export function handleConnections(c: Context): Response {
  return c.json({ ok: true, connected: connectionRegistry.ids() });
}

/**
 * POST /connection/disconnect — tear this bot's live socket down + drop it from
 * the registry (reassignment DETACH). Idempotent: `not_connected` is
 * a 200 (the caller's saga treats "already gone" == "torn down"). Only the botId
 * is read; disconnect never touches credentials, so the service is built with a
 * placeholder creds pair (the connect ports are present but unused on this path).
 */
export async function handleDisconnect(c: Context): Promise<Response> {
  const correlation = createCorrelationContext(c.req.raw);
  const raw = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;

  const parsed = disconnectRequestSchema.safeParse(raw);
  const context: Record<string, unknown> = { svc: "gw-container" };
  if (parsed.success) context.botId = parsed.data.botId;
  const log = createStageLogger({ context, correlation });

  if (!parsed.success) {
    log.warn("connection.disconnect", "rejected disconnect with invalid body", { reason: "invalid_body" });
    return c.json({ ok: false, error: "botId is required" }, 400);
  }

  const service = new MessagingConnectionsService({
    connect: TelegramClientAdapter.connect,
    creds: { apiId: 0, apiHash: "" }, // unused by disconnect (no socket is created)
    registry: connectionRegistry,
    persistInbound: insertInboundMessage,
    readUpdateState,
    persistUpdateState: upsertUpdateState,
  });

  const result = await service.disconnect(parsed.data.botId);
  log.info("connection.disconnect", "disconnect processed", { outcome: result.kind });
  return c.json({ ok: true, botId: parsed.data.botId, disconnected: result.kind === "disconnected" });
}
