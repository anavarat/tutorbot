import { Api, helpers, TelegramClient, sessions } from "teleproto";
// Explicit `/index.js` (not the bare dir): teleproto ships no `exports` map, and
// Node ESM — unlike the tsc "Bundler" resolver / vitest — refuses a directory
// import (ERR_UNSUPPORTED_DIR_IMPORT). Keep the file suffix so the built ESM runs.
import { NewMessage, Raw, type NewMessageEvent } from "teleproto/events/index.js";
import { UpdateConnectionState } from "teleproto/network/index.js";

import type { InboundMessageFields } from "../../domain/messaging/inbound-filter.js";

const { StringSession } = sessions;

/**
 * ADAPTER (hexagonal `platform/` layer): the ONE and ONLY file in the container
 * that imports `teleproto`. Higher layers (the messaging-connections service) depend
 * on THIS shape, never on the MTProto SDK directly — same ports-and-adapters rule
 * as `bot-fleet/src/platform/ai/llm-client.ts`. Swapping/upgrading teleproto, or
 * faking it in a test, stays contained here.
 *
 * connect FROM a pre-minted StringSession + prove liveness (`getMe`).
 * `onNewMessage` surfaces inbound DMs as PLAIN `InboundMessageFields` (raw
 * `Api.Message` decoding stays here; the domain filter + persistence never touch
 * teleproto). The socket is deliberately long-lived (the container is a stateful
 * host now, not a stateless HTTP handler). `sendMessage` lands here too.
 */

/**
 * Conversation id in the customer's canonical format (ported from
 * `EventManager.getChatIdFromPeer`, telegrambot `EventManager.ts:2219`): DM =
 * bare user id, group chat = `-<id>`, channel = `-100<id>`. This MUST match the
 * customer's format because it becomes `channel_chat_id` and feeds the shared
 * idempotency key the bot-fleet re-derives — diverge and dedup silently breaks.
 */
function getChatIdFromPeer(peer: Api.TypePeer | undefined): string {
  if (!peer) return "unknown";
  if (peer instanceof Api.PeerUser) return peer.userId.toString();
  if (peer instanceof Api.PeerChat) return `-${peer.chatId.toString()}`;
  if (peer instanceof Api.PeerChannel) return `-100${peer.channelId.toString()}`;
  return "unknown";
}

/**
 * Extract the new message id from a raw `messages.SendMessage` result.
 * teleproto's high-level `sendMessage` does this internally (messages.js:606-623);
 * because we invoke the request DIRECTLY (to set our own `random_id`) we must mirror
 * it. A DM send returns either `UpdateShortSentMessage` (has `id`) or an `Updates`
 * container carrying an `UpdateMessageID` (the authoritative random_id->id map) and
 * an `UpdateNewMessage`. Prefer `UpdateMessageID`, fall back to the new message.
 */
function extractSentMessageId(result: Api.TypeUpdates): string {
  if (result instanceof Api.UpdateShortSentMessage) return String(result.id);
  const updates = "updates" in result ? result.updates : [];
  for (const u of updates) {
    if (u instanceof Api.UpdateMessageID) return String(u.id);
  }
  for (const u of updates) {
    if (
      (u instanceof Api.UpdateNewMessage || u instanceof Api.UpdateNewChannelMessage) &&
      u.message instanceof Api.Message
    ) {
      return String(u.message.id);
    }
  }
  return "";
}

/** Coarse message type — enough for the text-only gate (full media taxonomy is a later addition). */
function coarseType(message: Api.Message): string {
  if (message.media) return "media";
  if (message.message) return "text";
  if (message.action) return "service";
  return "unknown";
}

/** App-level MTProto credentials (the "app", not the account — accounts differ by session). */
export interface TelegramCreds {
  apiId: number;
  apiHash: string;
}

/** The subset of the account identity needs to prove the socket is authenticated. */
export interface TelegramIdentity {
  id: string;
  username: string | null;
  phone: string | null;
}

/**
 * MTProto update cursor — Telegram's server-side read-offset into the account's
 * update stream. `pts`/`qts` = the "how many updates have I consumed" counters
 * for the common vs secret streams; `date` = last-seen update timestamp; `seq` =
 * update-container ordering. teleproto holds this ONLY in memory
 * (`client._updateState`), so it dies with the process; we persist it (Postgres) and
 * restore it on reconnect so `catchUp()` can replay everything missed while down.
 *
 */
export interface UpdateState {
  pts: number;
  qts: number;
  date: number;
  seq: number;
}

/**
 * teleproto's `TelegramClient` does NOT type its internal update-state field or
 * `catchUp()` in a way we can reach cleanly, so we poke them through this narrow
 * shape. This is a DELIBERATE abstraction leak into a private field
 * (`_updateState`) — the one place we accept coupling to teleproto internals, and
 * it lives here in the sole adapter that owns the SDK. If a teleproto upgrade
 * renames `_updateState`, THIS is what breaks (guarded by getUpdateState() returning
 * null -> catch-up degrades to "from now", never crashes). Verified against
 * teleproto@1.224.1 client/updates.js (_updateState init :203, catchUp :198).
 */
interface TelegramClientInternals {
  _updateState?: UpdateState | null;
  catchUp(): Promise<void>;
}

/**
 * Telegram allows only ONE live connection per auth_key. During a redeploy /
 * container re-placement / rollout overlap, the OUTGOING instance may still hold
 * this session's socket for a short window, so the incoming instance's connect
 * hits `406 AUTH_KEY_DUPLICATED` on InvokeWithLayer. That is TRANSIENT — the old
 * socket frees within a second or two (its SIGTERM drain runs) — so we retry with
 * a short linear backoff rather than failing the whole provision.
 */
const AUTH_KEY_DUP_MAX_ATTEMPTS = 4;
const AUTH_KEY_DUP_BACKOFF_MS = 1_500;

function isAuthKeyDuplicated(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.includes("AUTH_KEY_DUPLICATED");
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class TelegramClientAdapter {
  private constructor(private readonly client: TelegramClient) {}

  /**
   * Connect FROM a pre-minted StringSession (the offline auth tool minted it; a
   * container has no stdin for the one-time OTP). Ctor reconnection opts mirror
   * the customer monolith (TelegramBot.ts:245-249) so the socket self-heals:
   * autoReconnect + bounded retries. `connect()` only establishes the transport
   * and SUCCEEDS EVEN ON A REVOKED SESSION, so we must verify `isUserAuthorized()`
   * (same trap fryan calls out at telegram.ts:384) — otherwise a dead session
   * looks "connected" until the first real request fails.
   *
   * @throws Error("session_unauthorized") when the StringSession is revoked/expired.
   */
  static async connect(sessionCredential: string, creds: TelegramCreds): Promise<TelegramClientAdapter> {
    let lastAuthKeyDupError: unknown;

    for (let attempt = 1; attempt <= AUTH_KEY_DUP_MAX_ATTEMPTS; attempt++) {
      // Rebuild the client each attempt: a connect that failed with
      // AUTH_KEY_DUPLICATED leaves the socket in an unusable state.
      const session = new StringSession(sessionCredential);
      const client = new TelegramClient(session, creds.apiId, creds.apiHash, {
        connectionRetries: 10,
        retryDelay: 2000,
        autoReconnect: true,
        timeout: 30,
        requestRetries: 5,
      });

      try {
        await client.connect();

        if (!(await client.isUserAuthorized())) {
          await client.disconnect().catch(() => {});
          throw new Error("session_unauthorized");
        }

        return new TelegramClientAdapter(client);
      } catch (e) {
        await client.disconnect().catch(() => {});

        // Dead session is terminal — re-minting is required, retrying won't help.
        if (e instanceof Error && e.message === "session_unauthorized") throw e;

        // Retry ONLY the transient duplicate-connection race (rollout overlap).
        if (isAuthKeyDuplicated(e) && attempt < AUTH_KEY_DUP_MAX_ATTEMPTS) {
          lastAuthKeyDupError = e;
          await sleep(AUTH_KEY_DUP_BACKOFF_MS * attempt); // 1.5s, 3s, 4.5s
          continue;
        }

        throw e;
      }
    }

    // Exhausted all attempts on AUTH_KEY_DUPLICATED — surface the last one.
    throw lastAuthKeyDupError instanceof Error
      ? lastAuthKeyDupError
      : new Error(String(lastAuthKeyDupError));
  }

  /** Account identity — proof the authenticated socket is live (done-test). */
  async getMe(): Promise<TelegramIdentity> {
    const me = (await this.client.getMe()) as {
      id?: unknown;
      username?: unknown;
      phone?: unknown;
    } | null;
    return {
      id: me?.id != null ? String(me.id) : "",
      username: typeof me?.username === "string" ? me.username : null,
      phone: typeof me?.phone === "string" ? me.phone : null,
    };
  }

  /**
   * inbound seam. Register a handler for new messages on the LIVE socket and
   * hand each one UP as plain `InboundMessageFields` — the only place raw
   * `Api.Message` is decoded. `{ incoming: true }` drops the bot's own echoes at
   * the SDK level (cheap), but the domain filter still re-checks `isOutgoing` so
   * the policy stays testable without a socket. Non-`Api.Message` updates
   * (edits/deletes/reactions) are ignored here — is new-message only.
   *
   * The callback is invoked on the teleproto event loop with NO HTTP request in
   * scope: the DSN + botId it needs were cached at connect, so the caller
   * closes over them. This handler lives as long as the client (one per bot);
   * a re-connect builds a NEW client, so handlers never stack across reconnects.
   */
  onNewMessage(handler: (fields: InboundMessageFields) => void): void {
    this.client.addEventHandler((event: NewMessageEvent) => {
      const message = event.message;
      if (!(message instanceof Api.Message)) return;

      const chatId = getChatIdFromPeer(message.peerId);
      handler({
        chatId,
        messageId: String(message.id),
        text: message.message ?? "",
        isOutgoing: message.out === true,
        isService: Boolean(message.action),
        hasMedia: Boolean(message.media),
        isGroup: chatId.startsWith("-"),
        senderId: message.fromId ? getChatIdFromPeer(message.fromId) : null,
        messageType: coarseType(message),
      });
    }, new NewMessage({ incoming: true }));
  }

  /**
   * outbound seam. Send `text` to `chatId` (the customer's canonical id — same
   * value emitted as `channelChatId`) and return the REAL MTProto message id.
   * `getInputEntity` resolves the peer (incl. its access hash) from teleproto's
   * session entity cache, which the inbound DM already populated — so a reply to
   * someone who just DM'd us needs no prior contact-add. Mirrors the customer send
   * path (telegrambot `TelegramBot.ts:1578`). DM-only: no `replyTo` quoting (that
   * is humanization, out of scope).
   *
   * (exactly-once): when `randomId` is supplied we BYPASS the high-level
   * `sendMessage` (which mints a fresh `random_id` every call -> at-least-once) and
   * invoke `messages.SendMessage` directly with OUR stable `random_id`
   * (`deriveRandomId(idempotencyKey)`). Telegram de-duplicates sends with the same
   * `random_id` within its window, so a drainer re-drive after a lost ack is a
   * server-side no-op instead of a second real message. Omitting `randomId` keeps
   * the old at-least-once behaviour (dev/fallback).
   */
  async sendMessage(chatId: string, text: string, randomId?: bigint): Promise<string> {
    const entity = await this.client.getInputEntity(chatId);
    if (randomId === undefined) {
      const sent = await this.client.sendMessage(entity, { message: text });
      return sent?.id != null ? String(sent.id) : "";
    }
    const result = await this.client.invoke(
      new Api.messages.SendMessage({
        peer: entity,
        message: text,
        randomId: helpers.returnBigInt(randomId),
      }),
    );
    return extractSentMessageId(result);
  }

  /**
   * Serialize the (possibly refreshed) session for persistence. teleproto may
   * rotate the auth key on connect, so this is the value to re-persist to Postgres
   *, not the one originally fed in.
   */
  saveSession(): string {
    return (this.client.session as sessions.StringSession).save();
  }

  private get internals(): TelegramClientInternals {
    return this.client as unknown as TelegramClientInternals;
  }

  /**
   * Read the live MTProto update cursor so the caller can persist it (Postgres).
   * Returns null before teleproto has initialized the state (the update loop sets
   * it shortly after connect via updates.GetState) or if a teleproto upgrade moved
   * the field — the caller then simply skips this persist (catch-up degrades to
   * "replay from the last persisted cursor", never crashes).
   */
  getUpdateState(): UpdateState | null {
    const s = this.internals._updateState;
    if (!s || typeof s.pts !== "number") return null;
    return { pts: s.pts, qts: s.qts, date: s.date, seq: s.seq };
  }

  /**
   * P4b (cold-start catch-up). Seed the client's in-memory cursor from a persisted
   * one, then run teleproto's `catchUp()` — which calls `updates.getDifference(pts)`
   * and DISPATCHES every missed message as a normal `NewMessage` event
   * (teleproto updates.js:_processDifference builds an UpdateNewMessage per missed
   * message). So the messages the gateway missed while it was DOWN flow back through
   * the SAME `onNewMessage` seam -> Postgres, idempotently. MUST be called AFTER
   * `onNewMessage` is wired (else the replayed events have no handler).
   *
   * When `state` is null (fresh bot, never persisted) this is a no-op restore + a
   * catchUp that just establishes the baseline cursor at "now".
   *
   * The assignment races teleproto's own update loop (which lazily inits
   * `_updateState` from GetState if null): whichever runs first, the loop only
   * writes when the field is null, so our non-null restore wins and catchUp reads
   * the persisted (older) pts. Best-effort: throws are the caller's to swallow —
   * the live socket already ingests NEW messages regardless.
   */
  async restoreAndCatchUp(state: UpdateState | null): Promise<void> {
    if (state) {
      this.internals._updateState = { pts: state.pts, qts: state.qts, date: state.date, seq: state.seq };
    }
    await this.internals.catchUp();
  }

  /**
   * P4a (transient in-process drop). teleproto ALREADY auto-recovers a live pts gap
   * (updates.js:_processUpdate detects the gap -> _recoverCommonGap -> getDifference
   * -> dispatch) and auto-reconnects the socket (ctor autoReconnect:true). This is a
   * deterministic belt-and-suspenders on top: on every RE-connect (a `connected`
   * that follows a `disconnected`, so never the initial connect) fire an explicit
   * `catchUp()`. Fully self-contained + best-effort — the callback never throws, and
   * if teleproto ever stops routing UpdateConnectionState to Raw handlers we simply
   * fall back to the built-in auto-recovery.
   */
  enableReconnectCatchUp(): void {
    let sawDisconnect = false;
    this.client.addEventHandler((update: unknown) => {
      if (!(update instanceof UpdateConnectionState)) return;
      if (update.state === UpdateConnectionState.disconnected) {
        sawDisconnect = true;
        return;
      }
      if (update.state === UpdateConnectionState.connected && sawDisconnect) {
        sawDisconnect = false;
        void this.internals.catchUp().catch(() => {});
      }
    }, new Raw({}));
  }

  async disconnect(): Promise<void> {
    await this.client.disconnect();
  }
}
