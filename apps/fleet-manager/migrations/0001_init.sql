-- Fleet registry: one row per bot. The DO namespace has no "list instances"
-- API, so this table is the source of truth for which bots exist and their
-- last-known lifecycle state. The live DO is still authoritative for runtime
-- counters (stats()); this row is control-plane metadata.
CREATE TABLE IF NOT EXISTS bots (
  bot_id     TEXT PRIMARY KEY,
  gateway_id TEXT NOT NULL,                       -- gateway/container this bot attaches to, e.g. "gw-1"
  status     TEXT NOT NULL DEFAULT 'provisioning',  -- provisioning | running | stopped | failed
  created_at INTEGER NOT NULL,                       -- epoch ms
  updated_at INTEGER NOT NULL                        -- epoch ms
);

CREATE INDEX IF NOT EXISTS idx_bots_status ON bots(status);
-- Supports "list all bots on gateway X" (the natural fan-out query).
CREATE INDEX IF NOT EXISTS idx_bots_gateway_id ON bots(gateway_id);

-- Monotonic id allocator for auto-generated bot ids (bot-N), used when the
-- caller does not supply a botId. Kept separate from `bots` so ids stay
-- monotonic even across deletes (COUNT/MAX-based schemes would recycle ids).
CREATE TABLE IF NOT EXISTS counters (
  name  TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0
);
