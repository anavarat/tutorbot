/**
 * Idempotency-key contract shared by the gateway (which INSERTs inbound rows and
 * STAMPs outbound replies) and the bot-fleet (which reads inbound rows and mints
 * reply rows). Both sides must derive the exact same deterministic token or the
 * `UNIQUE (bot_id, idempotency_key)` dedup + the `channel_message_id` stamp stop
 * matching — a silent break. Keeping the format here makes it a single,
 * compiler-enforced source of truth instead of two hand-copied template literals.
 */

/** Namespace prefix for a reply key, so a reply never collides with the inbound row it answers. */
export const REPLY_KEY_PREFIX = "reply:";

/**
 * Inbound message key: `{channel}:{channelChatId}:{channelMessageId}`.
 * Built gateway-side on ingress (insertInboundMessage); read back verbatim by the
 * bot-fleet as the anchor for its reply key. Carries no botId (already the first
 * column of the UNIQUE) and no timestamp, so it is stable across redelivery/recovery.
 */
export function buildInboundKey(
  channel: string,
  channelChatId: string,
  channelMessageId: string,
): string {
  return `${channel}:${channelChatId}:${channelMessageId}`;
}

/**
 * Reply key: `reply:` + the anchor inbound key. Minted once by the DO and used for
 * BOTH the outbound INSERT (recordSentMessage) and the /deliver call the gateway
 * stamps on, so a re-driven turn passes the SAME key (idempotent no-op).
 */
export function buildReplyKey(inboundKey: string): string {
  return `${REPLY_KEY_PREFIX}${inboundKey}`;
}

/** The three parts encoded in an inbound (and, minus the prefix, a reply) key. */
export interface ParsedMessageKey {
  channel: string;
  channelChatId: string;
  channelMessageId: string;
}

/**
 * Inverse of `buildReplyKey(buildInboundKey(...))`: recover the routing parts from
 * a reply key. The GATEWAY needs this on OUTBOUND — the bot-fleet's /deliver call
 * carries only the reply key + content, so the container parses the destination
 * `channelChatId` out of the key to know WHERE to send. Splits on the FIRST
 * two colons only, so a `channelMessageId` that itself contains `:` stays intact;
 * `channel` and `channelChatId` are plain tokens (no colon) by construction.
 *
 * @throws if `key` lacks the `reply:` prefix or any of the three parts is empty.
 */
export function parseReplyKey(key: string): ParsedMessageKey {
  if (!key.startsWith(REPLY_KEY_PREFIX)) {
    throw new Error(`not a reply key (missing '${REPLY_KEY_PREFIX}' prefix): ${key}`);
  }
  const body = key.slice(REPLY_KEY_PREFIX.length);
  const firstColon = body.indexOf(":");
  const secondColon = body.indexOf(":", firstColon + 1);
  if (firstColon === -1 || secondColon === -1) {
    throw new Error(`malformed reply key (expected channel:chatId:messageId): ${key}`);
  }
  const channel = body.slice(0, firstColon);
  const channelChatId = body.slice(firstColon + 1, secondColon);
  const channelMessageId = body.slice(secondColon + 1);
  if (!channel || !channelChatId || !channelMessageId) {
    throw new Error(`malformed reply key (empty part): ${key}`);
  }
  return { channel, channelChatId, channelMessageId };
}

/**
 * Derive a STABLE 64-bit send id from a reply idempotency-key (exactly-once
 * outbound). The channel adapter feeds this to its SDK as the send's
 * dedup token — MTProto `messages.sendMessage.random_id` (Telegram) or the
 * `messageId`/`key.id` (Telegram/Baileys) — so a RE-DRIVEN send (drainer retry
 * after a lost ack) presents the SAME id and the channel server DE-DUPLICATES it,
 * instead of teleproto's default fresh-random-per-call which puts a SECOND real
 * message on the wire.
 *
 * WHY here (not the channel adapter): it is a pure function OF the shared
 * idempotency-key contract, and the same value must be derivable channel-side for
 * every channel — so it lives with `buildReplyKey`/`parseReplyKey`.
 *
 * WHY a hand-rolled FNV-1a and NOT `node:crypto` SHA-256: this file is in
 * `@tutorbot/shared`, imported by the Worker too (DB_DSN_FIELD etc.), so it must stay
 * runtime-neutral — no `node:crypto` in the Worker bundle, and no async
 * `crypto.subtle`. 64-bit FNV-1a over the UTF-8 bytes is deterministic, synchronous,
 * dependency-free, and works identically in Node + Workers. We do NOT need
 * cryptographic strength: only determinism + negligible collision across DISTINCT
 * keys. A collision needs ~2^32 keys (birthday) AND both sends inside the channel's
 * short dedup window — astronomically unlikely at chat scale — and even then it only
 * ever suppresses a duplicate, never corrupts content.
 *
 * Returns a SIGNED int64 (`bigint`): the wire type is `long`, and folding the
 * unsigned 64-bit hash into signed range keeps the value canonical regardless of
 * how the SDK interprets the sign bit.
 */
export function deriveRandomId(idempotencyKey: string): bigint {
  const MASK = (1n << 64n) - 1n;
  const TWO_63 = 1n << 63n;
  const TWO_64 = 1n << 64n;
  let hash = 14695981039346656037n; // FNV-1a 64-bit offset basis
  const bytes = new TextEncoder().encode(idempotencyKey);
  for (let i = 0; i < bytes.length; i++) {
    hash ^= BigInt(bytes[i]);
    hash = (hash * 1099511628211n) & MASK; // FNV-1a 64-bit prime, kept in 64 bits
  }
  return hash >= TWO_63 ? hash - TWO_64 : hash; // unsigned -> signed int64
}
