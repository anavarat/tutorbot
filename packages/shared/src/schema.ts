/**
 * Canonical messaging schema (channel-agnostic `chat` + UNIFIED `message`) for the
 * Supabase message store. The gateway-container inbound store
 * (insertInboundMessage) runs this verbatim as an idempotent
 * `CREATE IF NOT EXISTS` boot guard, and the bot-fleet polls these same
 * rows over Hyperdrive. Keeping the DDL here makes it ONE source of truth instead
 * of two hand-copied blobs that must never drift: a column drift is a silent
 * cross-service break (the bot-fleet's poll SQL is hand-coupled to these names).
 *
 * Run as a single multi-statement simple query: `pool.query(MESSAGING_SCHEMA_DDL)`
 * (no params, so node-postgres allows the batch). `chat` is declared before
 * `message` because `message.chat_id REFERENCES chat(id)`.
 *
 * NOTE: this is the runtime boot-guard copy. The standalone ops scripts under
 * apps/bot-fleet/scripts/*.mjs keep their own inline DDL on purpose — they run as
 * plain `node` scripts outside the build graph and must not depend on this built
 * package.
 */
export const MESSAGING_SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS chat (
  id               BIGSERIAL   PRIMARY KEY,
  bot_id           TEXT        NOT NULL,
  channel          TEXT        NOT NULL,
  channel_chat_id  TEXT        NOT NULL,
  is_group         BOOLEAN     NOT NULL DEFAULT false,
  name             TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_message_at  TIMESTAMPTZ,
  turns            INT         NOT NULL DEFAULT 0,
  UNIQUE (bot_id, channel, channel_chat_id)
);

CREATE TABLE IF NOT EXISTS message (
  id                  BIGSERIAL   PRIMARY KEY,
  bot_id              TEXT        NOT NULL,
  chat_id             BIGINT      NOT NULL REFERENCES chat(id) ON DELETE CASCADE,
  channel_message_id  TEXT,
  idempotency_key     TEXT        NOT NULL,
  from_me             BOOLEAN     NOT NULL,
  content             TEXT        NOT NULL,
  ts                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  message_type        TEXT,
  channel_sender_id   TEXT,
  metadata            JSONB,
  UNIQUE (bot_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_message_bot_chat_id ON message (bot_id, chat_id, id);
CREATE INDEX IF NOT EXISTS idx_message_bot_fromme_id ON message (bot_id, from_me, id);

-- Delivery-state columns (idempotent boot-guard additions).
-- These describe a per-row delivery FSM on the OUTBOUND rows (from_me=true):
-- delivery_state, a per-row schedule/backoff (next_attempt_at), a claim lease
-- (lease_until) and an attempt counter. All ADD COLUMN IF NOT EXISTS, so this
-- stays a safe re-runnable boot guard.
--
-- TEACHING BUILD NOTE: the reduced bot-fleet delivers replies best-effort INLINE
-- (no separate outbox drainer / retry / dead-letter). These columns are retained
-- only so the schema and cross-service inserts stay compatible; outbound rows are
-- inserted with the DEFAULT 'PENDING' and simply never advance.
--
-- SCOPE: delivery_state is the OUTBOUND (from_me=true) reply FSM ONLY. INBOUND
-- rows (from_me=false) are inserted with the terminal sentinel 'RECEIVED' (see
-- gateway container store.ts) rather than the DEFAULT 'PENDING'. The DEFAULT stays
-- 'PENDING' because OUTBOUND INSERTs rely on it (bot-fleet message-repo). "Which
-- inbound have been replied to" is derived from the covering reply's
-- idempotency_key watermark (reply:CHANNEL:CHATID:MSGID).
ALTER TABLE message ADD COLUMN IF NOT EXISTS delivery_state  TEXT        NOT NULL DEFAULT 'PENDING';
ALTER TABLE message ADD COLUMN IF NOT EXISTS attempts        INT         NOT NULL DEFAULT 0;
ALTER TABLE message ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE message ADD COLUMN IF NOT EXISTS lease_until     TIMESTAMPTZ;
ALTER TABLE message ADD COLUMN IF NOT EXISTS last_error      TEXT;

-- Claim/scan index: only DUE, PENDING, outbound rows -> keeps the drainer's scan
-- O(pending) not O(table). Column order matches the claim's WHERE + ORDER BY.
CREATE INDEX IF NOT EXISTS idx_message_outbox_due
  ON message (bot_id, next_attempt_at, id)
  WHERE from_me = true AND delivery_state = 'PENDING';

-- Per-bot MTProto update cursor (pts/qts/date/seq) = Telegram's
-- server-side read-offset into the account's update stream (like a Kafka offset /
-- WAL LSN). teleproto keeps it ONLY in memory (client._updateState), so a
-- container restart loses it and resumes from "now" -> every DM that arrived while
-- the gateway was down is skipped. Persisting the cursor here lets the container,
-- on reconnect, restore it and call catchUp() -> updates.getDifference(pts) replays
-- the missed messages back through the normal inbound seam (idempotent via the
-- message UNIQUE, so an over-broad replay just de-dupes). This lives in Postgres (not
-- gateway DO storage) because it is a HIGH-FREQUENCY, per-bot operational counter
-- that the container already owns the write path to (inbound goes container->Postgres
-- direct); the DO stays the slow-changing credential/identity store. One row per
-- bot, UPSERT. Written on-change + coalesced (not per-message) since replay is
-- idempotent. BIGINT (not INT4) so the unix-seconds "date" survives 2038.
CREATE TABLE IF NOT EXISTS gateway_update_state (
  bot_id        TEXT        PRIMARY KEY,
  pts           BIGINT      NOT NULL,
  qts           BIGINT      NOT NULL,
  mtproto_date  BIGINT      NOT NULL,
  seq           BIGINT      NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;
