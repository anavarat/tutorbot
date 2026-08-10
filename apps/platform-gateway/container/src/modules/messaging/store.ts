import { buildInboundKey, MESSAGING_SCHEMA_DDL } from "@tutorbot/shared";

import type { UpdateState } from "../../platform/telegram/client.js";
import { getPool } from "../db/pool.js";

/**
 * Message-domain persistence for the gateway container. Inbound messages land in
 * the same `chat` + `message` tables the bot-fleet polls over Hyperdrive, so this
 * is the real ingress the bots react to. The schema is the shared
 * MESSAGING_SCHEMA_DDL (single source of truth in @tutorbot/shared); running it here
 * as CREATE IF NOT EXISTS keeps a fresh env bootable and no-ops once created.
 */
let schemaReady = false;

async function ensureSchema(dsn: string): Promise<void> {
  if (schemaReady) {
    return;
  }
  await getPool(dsn).query(MESSAGING_SCHEMA_DDL);
  schemaReady = true;
}

/** Fields the live MTProto socket supplies for one inbound message. */
export interface InboundParams {
  botId: string;
  /** Channel discriminator: `telegram` | `telegram` | … */
  channel: string;
  /** Channel-native conversation id (WA JID / TG chat.id). */
  channelChatId: string;
  /** Channel-native message id — pass-through, used to build the idempotency key. */
  channelMessageId: string;
  content: string;
  isGroup?: boolean;
  /** 1:1 = display name/number; group = subject. */
  name?: string | null;
  /** Sender within a group chat; null in a DM. */
  channelSenderId?: string | null;
  messageType?: string | null;
}

export interface InboundResult {
  /** id of the upserted `chat` row. */
  chatId: string;
  /** New `message` id, or null when it was a duplicate (idempotent no-op). */
  messageId: string | null;
  ts: string | null;
  idempotencyKey: string;
  /** true when ON CONFLICT DO NOTHING skipped the insert (channel redelivery). */
  duplicate: boolean;
}

/**
 * Persist one inbound message under the Step-1 schema:
 *  1) UPSERT the `chat` (unique per bot_id+channel+channel_chat_id) and bump its
 *     `last_message_at` — this is the GW-side write-back (bot stays channel-blind).
 *  2) INSERT the `message` as inbound (`from_me = false`) with a computed
 *     idempotency_key `{channel}:{channel_chat_id}:{channel_message_id}` and
 *     `ON CONFLICT (bot_id, idempotency_key) DO NOTHING`, so channel redelivery
 *     never double-inserts.
 */
export async function insertInboundMessage(dsn: string, p: InboundParams): Promise<InboundResult> {
  await ensureSchema(dsn);
  const pool = getPool(dsn);

  const chatRes = await pool.query<{ id: string }>(
    `INSERT INTO chat (bot_id, channel, channel_chat_id, is_group, name, last_message_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (bot_id, channel, channel_chat_id)
     DO UPDATE SET last_message_at = now(),
                   name = COALESCE(EXCLUDED.name, chat.name)
     RETURNING id::text AS id`,
    [p.botId, p.channel, p.channelChatId, p.isGroup ?? false, p.name ?? null],
  );
  const chatId = chatRes.rows[0].id;

  const idempotencyKey = buildInboundKey(p.channel, p.channelChatId, p.channelMessageId);
  // `delivery_state` is the OUTBOUND reply outbox FSM (PENDING->SENDING->SENT|DLQ),
  // meaningless for an inbound row (nothing to deliver — we RECEIVED it). We set it
  // to the terminal sentinel 'RECEIVED' explicitly instead of letting it fall to the
  // column DEFAULT 'PENDING', which read as "reply not yet sent" and was misleading.
  // The drainer only ever claims `from_me = true`, so this value is never acted on;
  // it exists purely so the row is honest at a glance. (Outbound INSERTs keep relying
  // on the 'PENDING' default — see bot-fleet message-repo.)
  const msgRes = await pool.query<{ id: string; ts: string }>(
    `INSERT INTO message
       (bot_id, chat_id, channel_message_id, idempotency_key, from_me, content, message_type, channel_sender_id, delivery_state)
     VALUES ($1, $2, $3, $4, false, $5, $6, $7, 'RECEIVED')
     ON CONFLICT (bot_id, idempotency_key) DO NOTHING
     RETURNING id::text AS id, ts::text AS ts`,
    [
      p.botId,
      chatId,
      p.channelMessageId,
      idempotencyKey,
      p.content,
      p.messageType ?? null,
      p.channelSenderId ?? null,
    ],
  );
  const row = msgRes.rows[0];
  return {
    chatId,
    messageId: row ? row.id : null,
    ts: row ? row.ts : null,
    idempotencyKey,
    duplicate: !row,
  };
}

/**
 * Stamp the channel's message id onto the bot's OUTBOUND reply row, marking it
 * DELIVERED. This is the GATEWAY-side "delivered" truth: the bot-fleet writes the
 * reply row (`from_me = true`) with `channel_message_id` NULL, and ONLY the
 * gateway — AFTER the channel actually accepted the send — fills it in. Keying on
 * (bot_id, idempotency_key) hits exactly that one row (the UNIQUE), and the
 * `channel_message_id IS NULL` guard makes a re-driven/duplicate delivery a
 * no-op, so the stamp is idempotent (safe against a lost delivery ack: re-driving
 * the same reply cannot double-stamp or overwrite the first channel id).
 *
 * @returns true  -> this call FRESHLY stamped the row (first successful delivery).
 *          false -> already stamped, or no matching NULL row -> idempotent no-op
 *                   (the caller then skips the temp-UI push so it shows once).
 * THROWS on a real DB error so /deliver can surface a 500 and let the bot-fleet
 * retry track try again (the row stays NULL until a stamp succeeds).
 *
 * this same UPDATE also drives the outbox row's `delivery_state` to
 * 'SENT'. The GATEWAY is the SINGLE writer of the SENT transition (the drainer
 * owns PENDING/SENDING/DLQ) — so a claimed row (SENDING, channel_message_id NULL)
 * becomes SENT here. The `channel_message_id IS NULL` guard keeps it idempotent
 * and race-safe: a re-driven duplicate delivery cannot re-stamp or un-SENT it.
 */
export async function stampChannelMessageId(
  dsn: string,
  botId: string,
  idempotencyKey: string,
  channelMessageId: string,
): Promise<boolean> {
  await ensureSchema(dsn);
  const res = await getPool(dsn).query(
    `UPDATE message SET channel_message_id = $3, delivery_state = 'SENT'
       WHERE bot_id = $1 AND idempotency_key = $2 AND channel_message_id IS NULL
     RETURNING id`,
    [botId, idempotencyKey, channelMessageId],
  );
  return res.rowCount === 1;
}

/**
 * Read the persisted MTProto update cursor for one bot (null if never
 * persisted — a fresh bot, so catch-up will just baseline at "now"). Cast the
 * BIGINT columns to text and Number() them: node-postgres returns int8 as a string
 * to avoid precision loss, but pts/qts/date/seq are all well within 2^53 so Number
 * is exact. Runs the boot-guard DDL first because this can be called at connect
 * BEFORE any inbound insert has created the table.
 */
export async function readUpdateState(dsn: string, botId: string): Promise<UpdateState | null> {
  await ensureSchema(dsn);
  const res = await getPool(dsn).query<{ pts: string; qts: string; mtproto_date: string; seq: string }>(
    `SELECT pts::text AS pts, qts::text AS qts, mtproto_date::text AS mtproto_date, seq::text AS seq
       FROM gateway_update_state WHERE bot_id = $1`,
    [botId],
  );
  const row = res.rows[0];
  if (!row) return null;
  return { pts: Number(row.pts), qts: Number(row.qts), date: Number(row.mtproto_date), seq: Number(row.seq) };
}

/**
 * UPSERT one bot's MTProto update cursor. Called on-change + coalesced (not
 * per-message — see service throttle) because replay is idempotent, so a slightly
 * stale cursor only widens the (de-duped) catch-up window. Single row per bot
 * keyed on the PRIMARY KEY.
 */
export async function upsertUpdateState(dsn: string, botId: string, s: UpdateState): Promise<void> {
  await ensureSchema(dsn);
  await getPool(dsn).query(
    `INSERT INTO gateway_update_state (bot_id, pts, qts, mtproto_date, seq, updated_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (bot_id)
     DO UPDATE SET pts = EXCLUDED.pts, qts = EXCLUDED.qts,
                   mtproto_date = EXCLUDED.mtproto_date, seq = EXCLUDED.seq,
                   updated_at = now()`,
    [botId, s.pts, s.qts, s.date, s.seq],
  );
}
