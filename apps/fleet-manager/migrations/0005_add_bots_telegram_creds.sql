-- Add the per-bot Telegram credential quad to the fleet registry.
--
-- Real Telegram (MTProto) replaces the sim seams. Every bot now maps to
-- one Telegram account, whose auth lives in FOUR values supplied at provision
-- time (the operator mints the StringSession OFFLINE via the local auth-ui, then
-- pastes it into the provision form):
--   api_id / api_hash    -- per-bot MTProto APP creds (anti-ban):
--                           a dedicated my.telegram.org app per account so a
--                           single app-id isn't correlated across the fleet.
--   phone                -- the account's number; operator-facing metadata only.
--                           NOT sent to the gateway (the StringSession already
--                           encodes the account); stored here for audit/recovery.
--   session_credential   -- the StringSession = FULL ACCOUNT ACCESS. FM is the
--                           master store; the gateway container is
--                           the only place it is actually consumed (opens the
--                           MTProto socket). NEVER echoed in API/UI reads (the
--                           service strips it + api_hash from the output view).
--
-- SECURITY (known open item): session_credential + api_hash are stored
-- PLAINTEXT for now. D1 is encrypted-at-rest by Cloudflare, but app-level
-- envelope encryption is deferred. Do not surface these columns in any response.
--
-- NULLABLE (no NOT NULL, no default): SQLite ADD COLUMN cannot add a NOT NULL
-- column without a default to a table that may hold rows, and existing rows
-- predate real Telegram. Presence is instead enforced at the request boundary
-- (provisionSchema requires all four). Non-destructive ADD COLUMN — no rebuild
-- (mirrors 0003's persona_name).
ALTER TABLE bots ADD COLUMN api_id INTEGER;
ALTER TABLE bots ADD COLUMN api_hash TEXT;
ALTER TABLE bots ADD COLUMN phone TEXT;
ALTER TABLE bots ADD COLUMN session_credential TEXT;
