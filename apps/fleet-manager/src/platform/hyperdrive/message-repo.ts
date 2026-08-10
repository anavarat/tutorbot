import { Client } from "pg";

/**
 * Read-only observability reads over the shared `message` table (Supabase, via
 * FM's own HYPERDRIVE binding — same config id bot-fleet uses). These back the
 * /ui Monitoring + Logs views ONLY; they never write, and they mirror the rest of
 * the FM Hyperdrive layer (persona-repo) in NEVER THROWING — a DB blip returns an
 * empty result so the dashboard degrades gracefully instead of 500ing.
 *
 * Why FM reads the table directly (not via bot-fleet): the log/monitor view is a
 * pure read of state bot-fleet already persists; proxying it through bot-fleet
 * would add a service-binding hop and a second code path for zero benefit. FM
 * already reads the persona catalog the same way.
 */

/** One bot's outbox roll-up — the derived signal behind the "Bot -> GW" light. */
export interface BotOutboxHealth {
  /** Epoch ms of the most recent SUCCESSFULLY SENT reply, or null if none yet. */
  lastSentAt: number | null;
  /**
   * Epoch ms of the OLDEST still-un-SENT reply (from_me AND delivery_state in
   * PENDING/SENDING), or null when nothing is in flight. This is the STALL signal
   * behind the "Bot -> GW" light: a reply sitting here longer than STALL_TTL means
   * the handoff is stuck (dead bot/drainer never attempts, or the gateway keeps
   * failing) — caught WITHOUT coupling to the bot/gateway lights and WITHOUT waiting
   * for the DLQ that a dead drainer would never even reach.
   */
  oldestUnsentAt: number | null;
  /**
   * DEPRECATED (kept for back-compat; no longer drives a light). delivery_state of
   * the MOST RECENT message (max id), either direction.
   */
  lastState: string | null;
  /**
   * DEPRECATED (kept for back-compat; no longer drives a light). delivery_state of
   * the most recent OUTBOUND reply. The "gw -> platform" light now derives purely
   * from lastSentAt freshness (recent SENT => green, else gray); a real red/yellow
   * awaits a live socket probe.
   */
  lastSendState: string | null;
  sent: number;
  pending: number;
  sending: number;
  dlq: number;
  /** Inbound rows (from_me = false), i.e. messages received for this bot. */
  received: number;
}

/**
 * FLEET OUTBOX HEALTH. One aggregate query across ALL bots (GROUP BY bot_id) —
 * the Monitoring tab renders every bot's lights from this single round-trip
 * rather than N per-bot probes. Returns a map keyed by bot_id; a bot with no
 * messages simply won't appear (the UI treats "missing" as all-zero).
 *
 * `delivery_state` is the outbound FSM (PENDING -> SENDING -> SENT | DLQ); inbound
 * rows carry the terminal sentinel 'RECEIVED', so counting
 * `NOT from_me` gives the received tally regardless of state. Never throws.
 */
export async function fleetOutboxHealth(
  connectionString: string,
): Promise<Record<string, BotOutboxHealth>> {
  const client = new Client({ connectionString });
  const toMs = (v: unknown): number | null => (v ? new Date(v as string).getTime() : null);
  try {
    await client.connect();
    const res = await client.query(
      `SELECT bot_id,
              max(ts) FILTER (WHERE from_me AND delivery_state = 'SENT')          AS last_sent_at,
              min(ts) FILTER (WHERE from_me AND delivery_state IN ('PENDING','SENDING')) AS oldest_unsent_at,
              (array_agg(delivery_state ORDER BY id DESC))[1]                     AS last_state,
              (array_agg(delivery_state ORDER BY id DESC) FILTER (WHERE from_me))[1] AS last_send_state,
              count(*) FILTER (WHERE from_me AND delivery_state = 'SENT')::int    AS sent,
              count(*) FILTER (WHERE from_me AND delivery_state = 'PENDING')::int AS pending,
              count(*) FILTER (WHERE from_me AND delivery_state = 'SENDING')::int AS sending,
              count(*) FILTER (WHERE from_me AND delivery_state = 'DLQ')::int     AS dlq,
              count(*) FILTER (WHERE NOT from_me)::int                            AS received
         FROM message
        GROUP BY bot_id`,
    );
    const out: Record<string, BotOutboxHealth> = {};
    for (const r of res.rows) {
      out[String(r.bot_id)] = {
        lastSentAt: toMs(r.last_sent_at),
        oldestUnsentAt: toMs(r.oldest_unsent_at),
        lastState: r.last_state == null ? null : String(r.last_state),
        lastSendState: r.last_send_state == null ? null : String(r.last_send_state),
        sent: Number(r.sent),
        pending: Number(r.pending),
        sending: Number(r.sending),
        dlq: Number(r.dlq),
        received: Number(r.received),
      };
    }
    return out;
  } catch {
    return {};
  } finally {
    try {
      await client.end();
    } catch {
      /* ignore teardown errors */
    }
  }
}

/** One line in the per-bot chat log (both directions), for the Logs tab. */
export interface ChatLogMessage {
  id: number;
  chatId: number;
  fromMe: boolean;
  /** 'RECEIVED' for inbound; PENDING|SENDING|SENT|DLQ for the bot's own replies. */
  deliveryState: string;
  content: string;
  /** Enqueue/receive time, epoch ms. */
  ts: number | null;
  /** Delivery attempts so far (outbound only; 0 for inbound). */
  attempts: number;
  /** Last delivery error, if any (outbound failures). */
  lastError: string | null;
}

/**
 * BOT CHAT LOG. The most recent `limit` messages for ONE bot across ALL its
 * chats, BOTH directions, returned oldest -> newest so the UI can group by
 * chat_id and render each thread in order. Fetched newest-first then reversed
 * (clip the OLDEST when a bot exceeds `limit`). Never throws.
 */
export async function botChatLog(
  connectionString: string,
  botId: string,
  limit: number,
): Promise<ChatLogMessage[]> {
  const client = new Client({ connectionString });
  const toMs = (v: unknown): number | null => (v ? new Date(v as string).getTime() : null);
  try {
    await client.connect();
    const res = await client.query(
      `SELECT id, chat_id, from_me, delivery_state, content, ts, attempts, last_error
         FROM message
        WHERE bot_id = $1
        ORDER BY id DESC
        LIMIT $2`,
      [botId, limit],
    );
    return res.rows
      .map((r) => ({
        id: Number(r.id),
        chatId: Number(r.chat_id),
        fromMe: Boolean(r.from_me),
        deliveryState: String(r.delivery_state),
        content: String(r.content),
        ts: toMs(r.ts),
        attempts: r.attempts == null ? 0 : Number(r.attempts),
        lastError: r.last_error == null ? null : String(r.last_error),
      }))
      .reverse();
  } catch {
    return [];
  } finally {
    try {
      await client.end();
    } catch {
      /* ignore teardown errors */
    }
  }
}
