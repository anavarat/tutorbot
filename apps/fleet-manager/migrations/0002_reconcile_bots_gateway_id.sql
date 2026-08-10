-- Reconcile fleet-registry schema drift.
--
-- An earlier revision of 0001_init.sql created `bots` with a `config` column and
-- NO `gateway_id`. The canonical 0001_init.sql now defines `gateway_id` (and no
-- `config`), but D1 tracks applied migrations by FILENAME, so rewriting 0001 in
-- place never re-ran on databases that had already applied it (e.g. the remote
-- fleet-registry). The result is a live table missing `gateway_id` and carrying a
-- NOT NULL `config`, which breaks BotsDao.upsertProvisioning.
--
-- Registry rows are disposable control-plane metadata (the BotFleetDO is
-- authoritative for runtime state), so we rebuild the tables to the canonical
-- shape. This is deterministic regardless of the prior schema: on a fresh DB it
-- simply re-creates what 0001 just made; on the drifted remote it replaces the
-- old shape. NOTE: this DROPS existing registry rows and resets the bot-N counter
-- (intended — bots are re-provisioned explicitly).
DROP TABLE IF EXISTS bots;
CREATE TABLE bots (
  bot_id     TEXT PRIMARY KEY,
  gateway_id TEXT NOT NULL,                         -- gateway/container this bot attaches to, e.g. "gw-1"
  status     TEXT NOT NULL DEFAULT 'provisioning',  -- provisioning | running | stopped | failed
  created_at INTEGER NOT NULL,                       -- epoch ms
  updated_at INTEGER NOT NULL                        -- epoch ms
);
CREATE INDEX IF NOT EXISTS idx_bots_status ON bots(status);
CREATE INDEX IF NOT EXISTS idx_bots_gateway_id ON bots(gateway_id);

DROP TABLE IF EXISTS counters;
CREATE TABLE counters (
  name  TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0
);
