import type { TelegramClientAdapter } from "../../platform/telegram/client.js";

/**
 * One bot's LIVE channel connection: the connected client + the state the event
 * plane needs when a message arrives with NO HTTP request to carry it.
 *
 * Named "connection" (not "session") to mirror the customer's own split — the
 * DURABLE credential = the session (telegrambot `AuthManager` / wa creds), the
 * EPHEMERAL live socket = the connection (`ConnectionManager`). Their verb says it
 * too: `recoverSession()` means "the connection dropped → recover the session".
 * So this is the ephemeral half: lost on restart, rebuilt by recoverSession()
 * from the durable `sessionCredential` in Postgres. "channel" = this repo's
 * platform word (channelChatId / channelMessageId, store.ts).
 */
export interface ChannelConnection {
  client: TelegramClientAdapter;
  /** = botAccountId (1:1). */
  botId: string;
  /**
   * Postgres DSN cached AT CONNECT for inbound-at-event-time (the crux): a real
   * `NewMessage` is a SOCKET EVENT with no request, so it can't carry the DSN on
   * its own. The connect call carries it once; the event handler reads it from
   * here to persist the inbound message.
   */
  dsn: string;
}

/**
 * Process-wide registry mapping a bot (by botAccountId) to its live
 * ChannelConnection. THIS is the messaging-connections bounded context's runtime
 * state — the container is now stateful (was stateless HTTP). A module-level
 * singleton like `db/pool.ts`: /connection/connect writes it, the inbound event
 * handler + /deliver read it. Lost on restart; rebuilt by
 * recoverSession() from Postgres.
 */
const byBot = new Map<string, ChannelConnection>();

export const connectionRegistry = {
  get: (botAccountId: string): ChannelConnection | undefined => byBot.get(botAccountId),
  set: (botAccountId: string, connection: ChannelConnection): void => {
    byBot.set(botAccountId, connection);
  },
  has: (botAccountId: string): boolean => byBot.has(botAccountId),
  delete: (botAccountId: string): boolean => byBot.delete(botAccountId),
  size: (): number => byBot.size,
  /** The botIds with a live connection right now — the health-probe surface for
   * FM's connection reconcile. Snapshot array (not the live keys). */
  ids: (): string[] => [...byBot.keys()],
};

export type ConnectionRegistry = typeof connectionRegistry;
