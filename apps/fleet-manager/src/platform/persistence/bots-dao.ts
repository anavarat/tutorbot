/** Raw row shape of the D1 `bots` registry table. */
export interface BotRow {
  bot_id: string;
  gateway_id: string; // gateway/container this bot attaches to, e.g. "gw-1"
  persona_name: string | null; // assigned persona display name, or null => fallback prompt
  status: string; // provisioning | running | stopped | failed
  created_at: number; // epoch ms
  updated_at: number; // epoch ms
  // Per-bot Telegram credential quad (migration 0005). Nullable at the DB level
  // (ADD COLUMN + pre-real-Telegram rows); presence is enforced at the request
  // boundary (provisionSchema). ⚠ api_hash + session_credential are SECRETS —
  // NEVER surfaced in the output view (BotService.view() strips them).
  api_id: number | null;
  api_hash: string | null;
  phone: string | null;
  session_credential: string | null;
  // Reassignment saga cursor (migration 0006). All NULL in the steady
  // state. `reassign_state` walks 'requested' -> 'detached' -> 'attached' during a
  // gw-A -> gw-B move and is cleared (back to NULL) on commit or rollback.
  reassign_target_gw: string | null;
  reassign_state: ReassignState | null;
  reassign_started_at: number | null; // epoch ms the move began
  // Last gateway->platform connect error for this bot (migration 0008). Written by
  // the 5-min heal sweep (reconcileConnections): a failed reconnect records the
  // container's error here; a successful/healthy socket clears it back to NULL. Feeds
  // traffic light #4 (which is otherwise blind to connect failures). NON-secret.
  last_conn_error: string | null; // e.g. 'session_unauthorized' / AUTH_KEY_DUPLICATED, NULL = none
  last_conn_error_at: number | null; // epoch ms the error was last observed
}

/**
 * The reassignment saga cursor (migration 0006). NULL (absent) = steady state.
 *   requested -> the move is recorded; nothing torn down yet.
 *   detached  -> the OLD gateway's socket is gone (zero-live window begins).
 *   attached  -> the NEW gateway's socket is live; routing/D1 not yet flipped.
 * Commit clears it to NULL with gateway_id = target; rollback clears it to NULL
 * leaving gateway_id on the OLD gateway.
 */
export type ReassignState = "requested" | "detached" | "attached";

/**
 * The per-bot Telegram credential quad, supplied at provision time (operator
 * mints the StringSession offline, pastes it into the form). Persisted verbatim;
 * `sessionCredential` is what the gateway container consumes to open the socket.
 */
export interface TelegramCreds {
  apiId: number;
  apiHash: string;
  phone: string;
  sessionCredential: string;
}

export type BotStatus = "provisioning" | "running" | "stopped" | "failed";

/**
 * Data access for the fleet registry. ALL D1 SQL lives here; higher layers work
 * with `BotRow` objects and never see SQL.
 */
export class BotsDao {
  constructor(private readonly db: D1Database) {}

  async get(botId: string): Promise<BotRow | null> {
    return this.db.prepare("SELECT * FROM bots WHERE bot_id = ?").bind(botId).first<BotRow>();
  }

  async list(): Promise<BotRow[]> {
    const { results } = await this.db
      .prepare("SELECT * FROM bots ORDER BY created_at ASC")
      .all<BotRow>();
    return results;
  }

  /**
   * Upsert a row as 'provisioning'; created_at is preserved on conflict.
   * `gatewayId`, `personaName` and the Telegram `creds` are overwritten on
   * re-provision with exactly the values given (plain SET, not COALESCE): the
   * caller (BotService) already resolved the EFFECTIVE persona, and creds are
   * always re-supplied at provision, so this DAO just writes what it's told.
   * Pass `personaName = null` to clear the assignment (bot runs the fallback
   * prompt). ⚠ creds.apiHash + creds.sessionCredential are secrets — stored
   * plaintext for now (see migration 0005), never logged here.
   */
  async upsertProvisioning(
    botId: string,
    gatewayId: string,
    personaName: string | null,
    creds: TelegramCreds,
    now: number,
  ): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO bots
           (bot_id, gateway_id, persona_name, api_id, api_hash, phone, session_credential, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'provisioning', ?, ?)
         ON CONFLICT(bot_id) DO UPDATE SET
           gateway_id         = excluded.gateway_id,
           persona_name       = excluded.persona_name,
           api_id             = excluded.api_id,
           api_hash           = excluded.api_hash,
           phone              = excluded.phone,
           session_credential = excluded.session_credential,
           status             = 'provisioning',
           updated_at         = excluded.updated_at`,
      )
      .bind(
        botId,
        gatewayId,
        personaName,
        creds.apiId,
        creds.apiHash,
        creds.phone,
        creds.sessionCredential,
        now,
        now,
      )
      .run();
  }

  /**
   * Update ONLY the bot->gateway mapping (gateway_id + persona_name), leaving
   * `status` untouched. Used by PATCH /bots/:id (config update) — distinct from
   * upsertProvisioning, which flips status to 'provisioning'. The caller
   * (BotService) has already resolved the EFFECTIVE values (provided-wins-else-
   * keep-existing) and verified the row exists, so this is a plain UPDATE of the
   * two mapping columns. Pass `personaName = null` to clear the assignment.
   */
  async updateMapping(
    botId: string,
    gatewayId: string,
    personaName: string | null,
    now: number = Date.now(),
  ): Promise<void> {
    await this.db
      .prepare("UPDATE bots SET gateway_id = ?, persona_name = ?, updated_at = ? WHERE bot_id = ?")
      .bind(gatewayId, personaName, now, botId)
      .run();
  }

  /**
   * Reassignment saga — step 0 (NULL -> 'requested'). Records the target gateway
   * and the start clock, WITHOUT touching gateway_id (the mapping flips only at
   * commit, once the new socket is healthy). Written before any socket teardown so
   * a crash from here on is observable + resumable.
   */
  async beginReassign(botId: string, targetGw: string, startedAt: number): Promise<void> {
    await this.db
      .prepare(
        `UPDATE bots
            SET reassign_target_gw = ?, reassign_state = 'requested',
                reassign_started_at = ?, updated_at = ?
          WHERE bot_id = ?`,
      )
      .bind(targetGw, startedAt, startedAt, botId)
      .run();
  }

  /**
   * Reassignment saga — advance the cursor ('requested'->'detached'->'attached').
   * Written AFTER the step's side effect succeeds, so a crash re-runs that same
   * (idempotent) step rather than skipping it.
   */
  async setReassignState(botId: string, state: ReassignState, now: number = Date.now()): Promise<void> {
    await this.db
      .prepare("UPDATE bots SET reassign_state = ?, updated_at = ? WHERE bot_id = ?")
      .bind(state, now, botId)
      .run();
  }

  /**
   * Reassignment saga — COMMIT ('attached' -> steady on the new gateway). One
   * atomic UPDATE: flip gateway_id to the target and clear the whole saga cursor.
   * After this the routing-swap RPC (bot-fleet DO reconfigure) is fired; even if
   * that RPC fails, D1 is already authoritative for the new gateway.
   */
  async commitReassign(botId: string, newGatewayId: string, now: number = Date.now()): Promise<void> {
    await this.db
      .prepare(
        `UPDATE bots
            SET gateway_id = ?, reassign_target_gw = NULL, reassign_state = NULL,
                reassign_started_at = NULL, updated_at = ?
          WHERE bot_id = ?`,
      )
      .bind(newGatewayId, now, botId)
      .run();
  }

  /**
   * Reassignment saga — ROLLBACK / clear. Clears the saga cursor WITHOUT changing
   * gateway_id, leaving the bot on its ORIGINAL gateway (used when the attach step
   * fails and we re-connect the old gateway). Also the reconciler's "give up" path.
   */
  async clearReassign(botId: string, now: number = Date.now()): Promise<void> {
    await this.db
      .prepare(
        `UPDATE bots
            SET reassign_target_gw = NULL, reassign_state = NULL,
                reassign_started_at = NULL, updated_at = ?
          WHERE bot_id = ?`,
      )
      .bind(now, botId)
      .run();
  }

  /**
   * Reassignment saga — STUCK cursors for the reconciler. A saga is
   * "stuck" when its cursor is still set (reassign_state IS NOT NULL) AND it began
   * before `startedBefore` (i.e. older than the timeout). A healthy saga completes
   * in seconds and clears its cursor, so anything lingering past the window is a
   * crash between steps that the cron sweep must resume or roll back. Oldest first,
   * so the longest-broken bot is healed first.
   */
  async listStuckReassigns(startedBefore: number): Promise<BotRow[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM bots
           WHERE reassign_state IS NOT NULL AND reassign_started_at IS NOT NULL
             AND reassign_started_at < ?
           ORDER BY reassign_started_at ASC`,
      )
      .bind(startedBefore)
      .all<BotRow>();
    return results;
  }

  async setStatus(botId: string, status: BotStatus, now: number = Date.now()): Promise<void> {
    await this.db
      .prepare("UPDATE bots SET status = ?, updated_at = ? WHERE bot_id = ?")
      .bind(status, now, botId)
      .run();
  }

  async delete(botId: string): Promise<void> {
    await this.db.prepare("DELETE FROM bots WHERE bot_id = ?").bind(botId).run();
  }

  /**
   * Record this bot's last gateway->platform connect error (migration 0008), so
   * traffic light #4 can go RED on a KNOWN failure. Called by the heal sweep
   * (reconcileConnections) when a reconnect fails. Deliberately does NOT touch
   * `status` (a failed socket does not change lifecycle membership — the bot is
   * still RUNNING and the sweep keeps retrying) or `updated_at` (a probe outcome
   * is not a lifecycle edit — mirrors gateways-dao.recordProbe).
   */
  async recordConnError(botId: string, error: string, now: number = Date.now()): Promise<void> {
    await this.db
      .prepare("UPDATE bots SET last_conn_error = ?, last_conn_error_at = ? WHERE bot_id = ?")
      .bind(error, now, botId)
      .run();
  }

  /**
   * Clear a bot's connect error back to NULL (migration 0008). Called by the heal
   * sweep when the bot has (or regains) a live socket, so a stale red light
   * self-heals. Same no-`status`/no-`updated_at` rule as recordConnError.
   */
  async clearConnError(botId: string): Promise<void> {
    await this.db
      .prepare("UPDATE bots SET last_conn_error = NULL, last_conn_error_at = NULL WHERE bot_id = ?")
      .bind(botId)
      .run();
  }

  /**
   * The RUNNING bots pinned to a gateway (cold-start recovery roster).
   * Only `status = 'running'` — that is exactly the set that should hold a LIVE
   * socket, so a restarted container rebuilds those and nothing else (a stopped /
   * failed bot must NOT get a resurrected socket). Rows include the credential
   * columns; the caller shapes the secret-bearing recovery payload (see
   * gateways/controller `toRecoveryBots`).
   */
  async listRunningByGateway(gatewayId: string): Promise<BotRow[]> {
    const { results } = await this.db
      .prepare("SELECT * FROM bots WHERE gateway_id = ? AND status = 'running' ORDER BY created_at ASC")
      .bind(gatewayId)
      .all<BotRow>();
    return results;
  }

  /**
   * Count bots pinned to a gateway. Used by gateway reap (GatewayService) to
   * refuse removing a gateway that still has bots attached (would orphan them).
   */
  async countOnGateway(gatewayId: string): Promise<number> {
    const row = await this.db
      .prepare("SELECT COUNT(*) AS n FROM bots WHERE gateway_id = ?")
      .bind(gatewayId)
      .first<{ n: number }>();
    return row?.n ?? 0;
  }

  /**
   * Allocate the next auto-generated bot id (bot-N) from a monotonic D1 counter
   * via one atomic UPSERT ... RETURNING, so concurrent provisions don't collide.
   * Kept separate from `bots` so ids stay monotonic even across deletes. Used
   * only when the caller does not supply a botId.
   */
  async nextBotId(): Promise<string> {
    const row = await this.db
      .prepare(
        `INSERT INTO counters (name, value) VALUES ('bot', 1)
         ON CONFLICT(name) DO UPDATE SET value = value + 1
         RETURNING value`,
      )
      .first<{ value: number }>();
    return `bot-${row?.value ?? 1}`;
  }
}
