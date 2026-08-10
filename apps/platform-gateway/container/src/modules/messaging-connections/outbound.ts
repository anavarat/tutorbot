import { deriveRandomId, parseReplyKey } from "@tutorbot/shared";

import type { ConnectionRegistry } from "./state.js";

/**
 * Port for the gateway-side "delivered" stamp (default = messaging/store.stampChannelMessageId).
 * Returns true when THIS call freshly stamped the row (first delivery), false on
 * an idempotent no-op (already stamped / redelivery).
 */
export type OutboundStamper = (
  dsn: string,
  botId: string,
  idempotencyKey: string,
  channelMessageId: string,
) => Promise<boolean>;

export type SendReplyResult =
  | { kind: "sent"; channelMessageId: string; duplicate: boolean }
  | { kind: "not_connected" }
  | { kind: "send_failed"; error: string };

export interface OutboundDeps {
  registry: ConnectionRegistry;
  stamp: OutboundStamper;
}

/**
 * outbound orchestration for the messaging-connections context. The bot-fleet's
 * /deliver call carries only `{ botId, content, idempotencyKey }` — NOT a
 * destination — because it is channel-blind. This service:
 * 1. finds the bot's LIVE connection (the socket /connect cached in the registry),
 *   2. parses the destination `channelChatId` out of the reply key (shared contract),
 *   3. sends over the real MTProto socket -> real channel_message_id,
 *   4. STAMPS that id onto the reply row = the gateway "delivered" truth (idempotent).
 *
 * Ctor-injected deps (registry + stamp) keep it unit-testable without a socket or
 * Postgres. Errors return a tagged result (never throw) so /deliver can map "retry"
 * (503) vs terminal cleanly.
 */
export class OutboundService {
  constructor(private readonly deps: OutboundDeps) {}

  async sendReply(
    botId: string,
    idempotencyKey: string,
    content: string,
    dsn: string,
  ): Promise<SendReplyResult> {
    const conn = this.deps.registry.get(botId);
    if (!conn) {
      // No live socket for this bot (never connected, or lost on restart before
      // recovery). The bot-fleet retry track re-drives, by which time connect/
      // recover should have run.
      return { kind: "not_connected" };
    }

    let channelChatId: string;
    try {
      ({ channelChatId } = parseReplyKey(idempotencyKey));
    } catch (e) {
      return { kind: "send_failed", error: e instanceof Error ? e.message : String(e) };
    }

    //: derive a STABLE random_id from the (re-drive-stable) reply key so a
    // re-driven /deliver is server-side de-duped by Telegram instead of sending a
    // second real message. Same key -> same id, across retries and restarts.
    let channelMessageId: string;
    try {
      channelMessageId = await conn.client.sendMessage(
        channelChatId,
        content,
        deriveRandomId(idempotencyKey),
      );
    } catch (e) {
      return { kind: "send_failed", error: e instanceof Error ? e.message : String(e) };
    }

    const fresh = await this.deps.stamp(dsn, botId, idempotencyKey, channelMessageId);
    return { kind: "sent", channelMessageId, duplicate: !fresh };
  }
}
