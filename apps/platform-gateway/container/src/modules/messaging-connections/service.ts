import { createStageLogger } from "@tutorbot/shared/observability";

import { shouldIngestDm, type InboundMessageFields } from "../../domain/messaging/inbound-filter.js";
import type {
  TelegramClientAdapter,
  TelegramCreds,
  TelegramIdentity,
  UpdateState,
} from "../../platform/telegram/client.js";
import type { InboundParams, InboundResult } from "../messaging/store.js";
import type { ConnectionRegistry } from "./state.js";

/**
 * Port for creating a connected client, injected so the service is unit-testable
 * without a real socket (default wiring = `TelegramClientAdapter.connect`).
 */
export type TelegramConnector = (
  sessionCredential: string,
  creds: TelegramCreds,
) => Promise<TelegramClientAdapter>;

/**
 * Port for persisting one inbound message, injected so the event handler is
 * testable without Postgres (default wiring = `messaging/store.insertInboundMessage`).
 */
export type InboundPersister = (dsn: string, params: InboundParams) => Promise<InboundResult>;

/** ports: read/write the per-bot MTProto update cursor (default = messaging/store). */
export type UpdateStateReader = (dsn: string, botId: string) => Promise<UpdateState | null>;
export type UpdateStatePersister = (dsn: string, botId: string, state: UpdateState) => Promise<void>;

/**
 * Coalesce cursor writes: persist a bot's cursor at most once per this window.
 * Safe to be coarse — replay is idempotent, so a stale cursor only widens the
 * (de-duped) catch-up window on a cold start. Idle bots write nothing (persist is
 * only attempted when a message arrives), keeping this hibernation-cost friendly.
 */
const PTS_PERSIST_THROTTLE_MS = 60_000;

/** Result union (matches the repo's `{ kind }` service convention, bots/service.ts). */
export type ConnectResult =
  | { kind: "connected"; identity: TelegramIdentity }
  | { kind: "session_unauthorized" }
  | { kind: "connect_failed"; error: string };

/** Result of a disconnect: whether a live socket was actually found + torn down. */
export type DisconnectResult = { kind: "disconnected" } | { kind: "not_connected" };

export interface MessagingConnectionsDeps {
  connect: TelegramConnector;
  creds: TelegramCreds;
  registry: ConnectionRegistry;
  /** persist a filtered inbound DM (default = insertInboundMessage). */
  persistInbound: InboundPersister;
  /** read the persisted update cursor at connect (default = store.readUpdateState). */
  readUpdateState: UpdateStateReader;
  /** persist the update cursor on-change (default = store.upsertUpdateState). */
  persistUpdateState: UpdateStatePersister;
  /** Injectable clock for the persist throttle (default = Date.now). */
  now?: () => number;
}

/**
 * Application orchestration for the messaging-connections bounded context
 * (ctor-injected deps, no I/O of its own beyond the injected ports). connect
 * one bot's client from a pre-minted StringSession, prove liveness (getMe), and
 * cache it (+ DSN) in the registry. No Postgres.
 */
export class MessagingConnectionsService {
  /** Per-bot last cursor-persist wall-clock (ms) for the write throttle. */
  private readonly lastPtsPersistAt = new Map<string, number>();

  constructor(private readonly deps: MessagingConnectionsDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  async connect(botId: string, sessionCredential: string, dsn: string): Promise<ConnectResult> {
    // Tear down any prior live socket for THIS bot BEFORE opening a new one. A
    // re-connect reuses the same botId => the same StringSession => the same
    // MTProto auth_key, and Telegram permits only ONE live connection per
    // auth_key. Opening the new socket while the old one is still up trips
    // 406 AUTH_KEY_DUPLICATED, so we accept the brief gap and disconnect first.
    const previousConnection = this.deps.registry.get(botId);
    if (previousConnection) {
      await previousConnection.client.disconnect().catch((e) => {
        createStageLogger({ context: { svc: "gw-container", botId } }).warn(
          "connection.connect",
          "prior socket close failed before re-connect (may briefly trip AUTH_KEY_DUPLICATED — retried)",
          { error: e instanceof Error ? e.message : String(e) },
        );
      });
      this.deps.registry.delete(botId);
    }

    let client: TelegramClientAdapter;
    try {
      client = await this.deps.connect(sessionCredential, this.deps.creds);
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      // isUserAuthorized() failed inside the adapter: the StringSession is dead.
      if (error === "session_unauthorized") {
        return { kind: "session_unauthorized" };
      }
      return { kind: "connect_failed", error };
    }

    let identity: TelegramIdentity;
    try {
      identity = await client.getMe();
    } catch (e) {
      await client.disconnect().catch((closeErr) => {
        createStageLogger({ context: { svc: "gw-container", botId } }).warn(
          "connection.connect",
          "socket close failed while aborting a failed getMe (socket may linger until restart)",
          { error: closeErr instanceof Error ? closeErr.message : String(closeErr) },
        );
      });
      return { kind: "connect_failed", error: e instanceof Error ? e.message : String(e) };
    }

    this.deps.registry.set(botId, { client, botId, dsn });

    // inbound seam: from now on, every new DM on this socket flows
    // adapter -> domain filter -> Postgres. Registered AFTER the connection is cached
    // so the handler's closure carries the same botId + DSN ( cache). MUST be
    // wired BEFORE the P4b catch-up below, so replayed missed messages land here.
    client.onNewMessage((fields) => {
      void this.handleInbound(botId, dsn, client, fields);
    });

    // P4a: deterministic catch-up on any future socket RE-connect (belt over
    // teleproto's built-in auto gap-recovery). Self-contained in the adapter.
    client.enableReconnectCatchUp();

    // P4b: cold-start recovery. Restore the persisted update cursor and replay
    // everything that arrived while this gateway was DOWN — getDifference dispatches
    // each missed message back through the onNewMessage seam above. Best-effort: a
    // failure here must NOT fail connect (the live socket already ingests new DMs);
    // it only means the down-window backfill didn't run. Skipped when there is no
    // DSN (dev path) since the cursor lives in Postgres.
    if (dsn) {
      try {
        const saved = await this.deps.readUpdateState(dsn, botId);
        await client.restoreAndCatchUp(saved);
      } catch (e) {
        createStageLogger({ context: { svc: "gw-container", botId } }).warn(
          "connection.connect",
          "cold-start catch-up failed (new messages still ingest live)",
          { error: e instanceof Error ? e.message : String(e) },
        );
      }
    }

    return { kind: "connected", identity };
  }

  /**
   * Tear down one bot's live MTProto socket and drop it from the registry
   * (reassignment DETACH). Idempotent: a bot with no live connection
   * returns `not_connected` (not an error) — the caller's saga treats "already
   * gone" the same as "torn down just now". Best-effort on the socket close (a
   * failed disconnect must still remove the registry entry, so a stale socket can
   * never keep processing inbound for a bot that has moved to another gateway).
   */
  async disconnect(botId: string): Promise<DisconnectResult> {
    const conn = this.deps.registry.get(botId);
    if (!conn) return { kind: "not_connected" };
    // Best-effort close, but LOG a failure: the registry entry is dropped either way
    // (below), so a failed close means the in-memory socket is orphaned — it may keep
    // holding the auth_key until this gateway restarts/reaps (the AUTH_KEY_DUPLICATED
    // window feature 6 retries around). Surface it instead of swallowing silently.
    await conn.client.disconnect().catch((e) => {
      createStageLogger({ context: { svc: "gw-container", botId } }).warn(
        "connection.disconnect",
        "socket close failed (registry entry dropped anyway; socket may linger until restart)",
        { error: e instanceof Error ? e.message : String(e) },
      );
    });
    this.deps.registry.delete(botId);
    return { kind: "disconnected" };
  }

  /**
   * handler for ONE inbound message. Runs on the teleproto event loop with no
   * HTTP request in scope, so it must NEVER throw (an unhandled rejection here can
   * tear the socket down): it logs and swallows. Flow: pure domain filter decides
   * ingest, then the injected persister writes it to Postgres as `from_me=false`
   * (idempotent on redelivery via the shared key). Content is never logged.
   */
  private async handleInbound(
    botId: string,
    dsn: string,
    client: TelegramClientAdapter,
    fields: InboundMessageFields,
  ): Promise<void> {
    const log = createStageLogger({ context: { svc: "gw-container", botId } });

    // advance the persisted cursor. Done for EVERY inbound update (even a
    // filtered-out one) so the cursor tracks what we've actually consumed, and
    // BEFORE the ingest gate so a dropped DM still moves the watermark forward.
    // Throttled + best-effort — a cursor blip must never touch the socket.
    void this.persistCursor(botId, dsn, client);

    const decision = shouldIngestDm(fields);
    if (!decision.ingest) {
      log.debug("inbound.event", "dropped inbound message", { reason: decision.reason });
      return;
    }

    try {
      const row = await this.deps.persistInbound(dsn, {
        botId,
        channel: "telegram",
        channelChatId: fields.chatId,
        channelMessageId: fields.messageId,
        content: fields.text,
        isGroup: false,
        channelSenderId: fields.senderId,
        messageType: fields.messageType,
      });
      log
        .child({ chatId: row.chatId, idempotencyKey: row.idempotencyKey })
        .info(
          "inbound.event",
          row.duplicate ? "inbound message already stored (duplicate)" : "persisted inbound message",
          { messageId: row.messageId, duplicate: row.duplicate },
        );
    } catch (e) {
      // Swallow: a DB blip must not crash the socket. The message is lost for now;
      // catch-up re-ingests missed messages.
      log.error("inbound.event", "inbound persist failed", {
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  /**
   * Throttled, best-effort persist of the bot's MTProto update cursor to Postgres.
   * Reads the live cursor off the adapter and UPSERTs it at most once per
   * PTS_PERSIST_THROTTLE_MS. NEVER throws (runs on the socket event loop): a DB
   * blip just means the next cold start replays from a slightly older cursor
   * (idempotent). No DSN / no cursor yet -> no-op.
   */
  private persistCursor(botId: string, dsn: string, client: TelegramClientAdapter): void {
    if (!dsn) return;
    const now = this.now();
    const last = this.lastPtsPersistAt.get(botId) ?? 0;
    if (now - last < PTS_PERSIST_THROTTLE_MS) return;

    const state = client.getUpdateState();
    if (!state) return; // teleproto hasn't initialized the cursor yet (or field moved)

    this.lastPtsPersistAt.set(botId, now);
    void this.deps.persistUpdateState(dsn, botId, state).catch((e) => {
      createStageLogger({ context: { svc: "gw-container", botId } }).error(
        "cursor.persist",
        "update-cursor persist failed",
        { error: e instanceof Error ? e.message : String(e) },
      );
    });
  }
}
