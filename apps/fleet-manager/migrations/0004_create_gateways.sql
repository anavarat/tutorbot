-- Gateways as a first-class fleet entity (symmetric with `bots`, 0001).
--
-- Until now the gateway roster was HARD-CODED in the GW Worker's GATEWAY_IDS var
-- (apps/platform-gateway/worker/wrangler.jsonc) and FM only PROXIED it for
-- discovery. That made gateways non-provisionable: adding one meant editing
-- wrangler + redeploying. This table makes FM the source of truth for "which
-- gateways exist", so gateways can be provisioned/reaped from the control plane
-- exactly like bots. A bot's `gateway_id` (0001) now references a row here.
--
-- Container LIFECYCLE (boot/stop) is deliberately NOT modelled yet: a gateway row
-- is control-plane metadata; the live container is materialised lazily by the GW
-- Worker via getContainer(gatewayId). `status` is last-known metadata.
CREATE TABLE IF NOT EXISTS gateways (
  gateway_id TEXT PRIMARY KEY,
  label      TEXT,                                  -- optional human label, e.g. "AU / Telegram"
  status     TEXT NOT NULL DEFAULT 'active',         -- active | draining | reaped
  created_at INTEGER NOT NULL,                        -- epoch ms
  updated_at INTEGER NOT NULL                         -- epoch ms
);

CREATE INDEX IF NOT EXISTS idx_gateways_status ON gateways(status);

-- Seed the two gateways that were previously hard-coded in GATEWAY_IDS so existing
-- bots (bots.gateway_id = 'gw-1' / 'gw-2') keep validating after the cutover.
INSERT OR IGNORE INTO gateways (gateway_id, label, status, created_at, updated_at)
VALUES
  ('gw-1', NULL, 'active', CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('gw-2', NULL, 'active', CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000);

-- Seed the gw-N id allocator PAST the seeded ids so auto-generated ids start at
-- gw-3 (mirrors the `bot` counter). Reuses the shared `counters` table (0001).
INSERT OR IGNORE INTO counters (name, value) VALUES ('gateway', 2);
