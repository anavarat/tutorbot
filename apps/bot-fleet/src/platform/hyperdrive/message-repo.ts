import { Client } from "pg";

/** High-watermark page size per poll. */
const PAGE = 100;

/**
 * One inbound message as needed by the reply loop. `chatId` links the message to
 * its `chat` row so a reply can be attributed to the right conversation; the bot
 * stays channel-blind — it never sees the channel-native ids.
 */
export interface InboundMessage {
  id: number;
  chatId: number;
  content: string;
  /** The cross-system message join key (`{channel}:{channel_chat_id}:{channel_message_id}`). */
  idempotencyKey: string;
}

export interface DiscoverResult {
  /** Number of new inbound messages this poll (== messages.length, 0..PAGE). */
  rows: number;
  /** Advanced high-watermark cursor (id of the last / most-recent message). */
  newCursor: number;
  /** ALL new inbound messages since the cursor, ordered oldest -> newest. */
  messages: InboundMessage[];
  dbMs: number;
  dbErr?: string;
}

/**
 * DISCOVER phase. One Hyperdrive->Postgres high-watermark poll for a bot's own
 * INBOUND messages (`from_me = false AND id > cursor`, ordered, capped at PAGE).
 * The `from_me = false` filter keeps the bot from re-discovering its own replies.
 * Never throws: DB errors are captured in `dbErr` so the scheduled loop keeps its
 * cadence. BIGINT ids come back as strings, so they are coerced with Number().
 */
export async function discoverBotMessages(
  connectionString: string,
  botId: string,
  cursor: number,
): Promise<DiscoverResult> {
  let rows = 0;
  let newCursor = cursor;
  let messages: InboundMessage[] = [];
  let dbErr: string | undefined;
  const t0 = Date.now();
  const client = new Client({ connectionString });
  try {
    await client.connect();
    const res = await client.query(
      "SELECT id, chat_id, content, idempotency_key FROM message WHERE bot_id = $1 AND from_me = false AND id > $2 ORDER BY id ASC LIMIT $3",
      [botId, cursor, PAGE],
    );
    rows = res.rows.length;
    if (rows > 0) {
      messages = res.rows.map((r) => ({
        id: Number(r.id),
        chatId: Number(r.chat_id),
        content: String(r.content),
        idempotencyKey: String(r.idempotency_key),
      }));
      // Ordered ASC, so the last row is the most recent -> new high-watermark.
      newCursor = messages[messages.length - 1].id;
    }
  } catch (e) {
    dbErr = (e as Error).message;
  } finally {
    try {
      await client.end();
    } catch {
      /* ignore teardown errors */
    }
  }
  return { rows, newCursor, messages, dbMs: Date.now() - t0, dbErr };
}

export interface RecordSentResult {
  /** New outbound `message` row id; null when deduped (see `duplicate`) or on error. */
  id: number | null;
  /** True when the row already existed (ON CONFLICT DO NOTHING) — an idempotent no-op. */
  duplicate: boolean;
  dbMs: number;
  dbErr?: string;
}

/**
 * SEND phase. Persist the bot's canned reply into the UNIFIED `message` table as
 * an OUTBOUND row (`from_me = true`), linked to `chatId`. The DISCOVER query
 * filters `from_me = false`, so a reply is invisible to it by construction —
 * same table, no re-discovery. `channel_message_id` is left NULL until the
 * gateway stamps the delivered id.
 *
 * IDEMPOTENCY. `idempotencyKey` is the reply's deterministic key (derived from
 * the inbound it answers). The INSERT is `ON CONFLICT (bot_id, idempotency_key)
 * DO NOTHING`, so a re-run of the same wake is an idempotent no-op. Never throws
 * (mirrors discover); the error is surfaced in `dbErr`.
 */
export async function recordSentMessage(
  connectionString: string,
  botId: string,
  chatId: number,
  idempotencyKey: string,
  content: string,
): Promise<RecordSentResult> {
  let id: number | null = null;
  let dbErr: string | undefined;
  const t0 = Date.now();
  const client = new Client({ connectionString });
  try {
    await client.connect();
    const res = await client.query(
      "INSERT INTO message (bot_id, chat_id, from_me, content, idempotency_key) VALUES ($1, $2, true, $3, $4) ON CONFLICT (bot_id, idempotency_key) DO NOTHING RETURNING id",
      [botId, chatId, content, idempotencyKey],
    );
    id = res.rows[0] ? Number(res.rows[0].id) : null;
  } catch (e) {
    dbErr = (e as Error).message;
  } finally {
    try {
      await client.end();
    } catch {
      /* ignore teardown errors */
    }
  }
  return { id, duplicate: !dbErr && id === null, dbMs: Date.now() - t0, dbErr };
}

/**
 * Worker-level connectivity check (used by GET /ping-db): total message count.
 * THROWS on failure so the caller can surface a 500 — this never touches a DO.
 */
export async function countMessages(connectionString: string): Promise<number> {
  const client = new Client({ connectionString });
  try {
    await client.connect();
    const r = await client.query("SELECT count(*)::int AS messages FROM message");
    return r.rows[0]?.messages ?? 0;
  } finally {
    try {
      await client.end();
    } catch {
      /* ignore teardown errors */
    }
  }
}
