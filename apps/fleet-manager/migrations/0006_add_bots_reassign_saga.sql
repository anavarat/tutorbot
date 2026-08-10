-- Reassignment saga state (auto-connect).
--
-- Moving a running bot from gw-A to gw-B is a multi-step, crash-resumable saga
-- (detach old socket -> attach new socket -> commit routing), NOT a single call.
-- FleetManager is the orchestrator; these three columns are the DURABLE saga
-- cursor so a crash mid-move leaves an OBSERVABLE, resumable state instead of a
-- silently half-migrated bot.
--
--   reassign_target_gw   -- the gateway we are moving TO (NULL = steady state).
--   reassign_state       -- saga cursor: NULL = not reassigning; otherwise one of
--                           'requested' | 'detached' | 'attached'. The primary
--                           `status` column is deliberately NOT overloaded (it
--                           stays provisioning|running|stopped|failed) so lifecycle
--                           and in-flight-move are independent axes.
--   reassign_started_at  -- epoch ms the move began; a future reconciler uses this
--                           to detect a STUCK saga (started_at < now - timeout) and
--                           resume/rollback it. (Reconciler itself is deferred; the
--                           column lands now so no schema change is needed later.)
--
-- Ordering guarantee the states encode: detach-before-attach (never two
-- live sockets on one account -> no dual-socket / ban), and connect-before-commit
-- (D1 gateway_id flips only after the new socket is healthy -> clean rollback).
--
-- NULLABLE, no default: SQLite ADD COLUMN on a populated table forbids NOT NULL
-- without a default, and existing rows are (correctly) not mid-reassign. A NULL
-- reassign_state IS the steady state. Non-destructive ADD COLUMN (mirrors 0005).
ALTER TABLE bots ADD COLUMN reassign_target_gw TEXT;
ALTER TABLE bots ADD COLUMN reassign_state TEXT;
ALTER TABLE bots ADD COLUMN reassign_started_at INTEGER;

-- Supports the (deferred) reconciler sweep "find bots stuck mid-reassign" without
-- a full-table scan. Partial index: only in-flight rows are indexed, so steady
-- bots (reassign_state IS NULL, the vast majority) cost nothing.
CREATE INDEX IF NOT EXISTS idx_bots_reassign_state
  ON bots(reassign_state) WHERE reassign_state IS NOT NULL;
