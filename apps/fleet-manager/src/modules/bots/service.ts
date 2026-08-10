import type { BotStats, StartResult, StopResult } from "@tutorbot/shared/rpc";
import type { BotsDao, BotRow } from "../../platform/persistence/bots-dao";
import type { GatewaysDao, GatewayHealth } from "../../platform/persistence/gateways-dao";
import type { BotRuntime } from "../../platform/botfleet/bot-runtime";
import type { GatewayDirectory } from "../../platform/gateway/gateway-directory";
import type { GatewayConnections, ConnectionIdentity } from "../../platform/gateway/gateway-connection";
import type { ProvisionInput, UpdateBotInput } from "./schema";

/**
 * Output view of a registry row — the row MINUS its secrets. `session_credential`
 * and `api_hash` are full/partial account access and must NEVER leave FM via an
 * API/UI read, so `view()` (the single choke point every read path flows through)
 * drops them. Non-secret identifiers (api_id, phone) are kept so the operator can
 * see which account a bot is bound to.
 */
export type BotView = Omit<BotRow, "session_credential" | "api_hash">;

/** Live stats, or an error envelope if the DO RPC failed. */
type StatsOrError = BotStats | { error: string };

/** Shape a registry row for output. Built explicitly (not spread) so the two
 *  secret columns can never leak by accident — adding a new secret column fails
 *  loudly here rather than silently escaping. */
function view(row: BotRow): BotView {
  return {
    bot_id: row.bot_id,
    gateway_id: row.gateway_id,
    persona_name: row.persona_name,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
    api_id: row.api_id,
    phone: row.phone,
    // Reassignment saga cursor — non-secret control-plane state, surfaced so an
    // operator can see a bot mid-move (and confirm it cleared to null on completion).
    reassign_target_gw: row.reassign_target_gw,
    reassign_state: row.reassign_state,
    reassign_started_at: row.reassign_started_at,
    // Last gateway->platform connect error — non-secret control-plane signal, surfaced
    // so the UI (traffic light #4) can show a KNOWN connect failure (e.g.
    // AUTH_KEY_DUPLICATED) as red instead of a misleading gray.
    last_conn_error: row.last_conn_error,
    last_conn_error_at: row.last_conn_error_at,
  };
}

export type ProvisionResult =
  | { kind: "ok"; bot: BotView | null; start: StartResult; identity: ConnectionIdentity }
  | { kind: "start_failed"; bot: BotView | null; start: StartResult }
  | { kind: "unknown_gateway"; gatewayId: string; known: string[] }
  | { kind: "connection_failed"; botId: string; error: string }
  | { kind: "do_error"; botId: string; error: string };

export interface ListResult {
  count: number;
  bots: Array<BotView & { stats?: StatsOrError }>;
}

export type UpdateConfigResult =
  | { kind: "ok"; bot: BotView | null; restarted: boolean; reconfigured?: boolean; start?: StartResult }
  | { kind: "start_failed"; bot: BotView | null; start: StartResult }
  | { kind: "not_found"; botId: string }
  | { kind: "unknown_gateway"; gatewayId: string; known: string[] }
  // Reassignment saga: the target-gateway attach failed; the bot was rolled
  // back to its old gateway (D1 gateway_id unchanged), so it is still running there.
  | { kind: "connection_failed"; botId: string; error: string }
  | { kind: "do_error"; botId: string; error: string };

export type GetOneResult =
  | { kind: "ok"; bot: BotView; stats: StatsOrError }
  | { kind: "not_found"; botId: string };

export type StopResultOut =
  | { kind: "ok"; botId: string; stop: StopResult }
  | { kind: "not_found"; botId: string };

/** Result of POST /bots/:id/restart — force a fresh run of a RUNNING bot. */
export type RestartResult =
  | { kind: "ok"; bot: BotView | null; start: StartResult }
  | { kind: "start_failed"; bot: BotView | null; start: StartResult }
  | { kind: "not_running"; botId: string }
  | { kind: "not_found"; botId: string }
  | { kind: "do_error"; botId: string; error: string };

export type RemoveResult =
  | { kind: "ok"; botId: string }
  | { kind: "not_found"; botId: string };

/** One bot's outcome in a stuck-saga reconcile sweep. `fromState` = the
 *  cursor the saga was resumed FROM; `kind` = the resume's terminal result. */
export interface ReconcileSagaOutcome {
  botId: string;
  fromState: BotRow["reassign_state"];
  kind: UpdateConfigResult["kind"] | "error";
  error?: string;
}
export interface ReconcileSagasResult {
  swept: number;
  results: ReconcileSagaOutcome[];
}

/** One bot/gateway outcome in a connection health-probe sweep. */
export interface ReconcileConnectionOutcome {
  gatewayId: string;
  botId?: string; // absent for a whole-gateway outcome (gateway_unreachable)
  kind: "reconnected" | "reconnect_failed" | "no_credential" | "gateway_unreachable";
  error?: string;
}
export interface ReconcileConnectionsResult {
  gateways: number;
  running: number;
  results: ReconcileConnectionOutcome[];
}

/**
 * Bot lifecycle orchestration. Owns the D1 side-effects and DO RPC calls, and
 * returns tagged results; the controller maps those to HTTP status codes. No
 * HTTP types leak in here.
 *
 * Pattern: D1 is the source of truth for "which bots exist"; the DO addressed by
 * getByName(botId) is authoritative for runtime counters. Provisioning ==
 * upsert the row + fire the first RPC (a DO does nothing until called).
 */
export class BotService {
  constructor(
    private readonly bots: BotsDao,
    private readonly runtime: BotRuntime,
    private readonly gateways: GatewayDirectory,
    private readonly connections: GatewayConnections,
    // Registry DAO for gateways — used by the health sweep to persist each
    // gateway's container-liveness probe (traffic light #2 "actual" signal).
    private readonly gatewayStore: GatewaysDao,
  ) {}

  /** POST /bots — validate the gateway, upsert registry row, then start the DO. */
  async provision(input: ProvisionInput): Promise<ProvisionResult> {
    // Validate gatewayId against the GW roster BEFORE allocating a botId, so a
    // bad gateway never burns a counter id or creates a registry row. Skipped
    // when discovery is unconfigured/unreachable (describe() != "ok").
    const roster = await this.gateways.describe();
    if (roster.status === "ok" && !roster.gateways.includes(input.gatewayId)) {
      return { kind: "unknown_gateway", gatewayId: input.gatewayId, known: roster.gateways };
    }

    // Caller-supplied botId wins; otherwise allocate bot-N from the D1 counter.
    const botId = input.botId?.trim() || (await this.bots.nextBotId());
    const now = Date.now();

    // Resolve the EFFECTIVE persona: an explicit personaName wins, else reuse the
    // one already stored for this bot (re-provision without re-picking keeps the
    // assignment), else null (fallback prompt). Persona is FM-owned now, so this
    // same value is BOTH persisted and handed to the DO — they never diverge.
    const existing = await this.bots.get(botId);
    const effectivePersona: string | null = input.personaName ?? existing?.persona_name ?? null;

    // Persist the row (incl. the credential quad) BEFORE any network call, so the
    // creds are durable even if the connect below fails and needs a retry.
    await this.bots.upsertProvisioning(
      botId,
      input.gatewayId,
      effectivePersona,
      {
        apiId: input.apiId,
        apiHash: input.apiHash,
        phone: input.phone,
        sessionCredential: input.sessionCredential,
      },
      now,
    );

    // Open the MTProto socket in the target container BEFORE starting the poll
    // loop, so the outbound channel is live by the time the first reply is due.
    // The session credential travels FM -> GW directly (never via bot-fleet). A
    // connect failure fails the whole provision (row left 'failed', loop never
    // started) — a bot with no live channel must not silently poll.
    const conn = await this.connections.connect({
      gatewayId: input.gatewayId,
      botId,
      apiId: input.apiId,
      apiHash: input.apiHash,
      sessionCredential: input.sessionCredential,
    });
    if (!conn.ok) {
      await this.bots.setStatus(botId, "failed");
      return { kind: "connection_failed", botId, error: conn.error };
    }

    let start: StartResult;
    try {
      start = await this.runtime.start(botId, {
        gatewayId: input.gatewayId,
        personaName: effectivePersona ?? undefined,
        runMinutes: input.runMinutes,
        force: input.force,
      });
    } catch (e) {
      await this.bots.setStatus(botId, "failed");
      return { kind: "do_error", botId, error: (e as Error).message };
    }

    await this.bots.setStatus(botId, start.ok ? "running" : "failed");
    const row = await this.bots.get(botId);
    const bot = row ? view(row) : null;
    return start.ok
      ? { kind: "ok", bot, start, identity: conn.identity }
      : { kind: "start_failed", bot, start };
  }

  /**
   * PATCH /bots/:id — update the bot's gateway/persona mapping. Always records the
   * new mapping in D1 (control-plane desired state). How it reaches a RUNNING bot
   * depends on WHAT changed:
   *   - gateway-only change (no persona) => LIVE reconfigure(): the DO swaps
   *     gatewayId in run-state and the next scheduled poll delivers to the new
   *     gateway, with cursor / cadence / counters intact (non-disruptive).
   *   - persona change => force-restart via start(): persona needs a DB
   *     re-hydration, so it rides the full restart path (fresh run: cursor 0,
   *     counters reset, new poll window).
   * A stopped/failed/provisioning bot is updated in D1 only; the change applies the
   * next time it is started. Forcing a fresh run WITHOUT a mapping change is a
   * separate action — see restart() (POST /bots/:id/restart).
   */
  async updateConfig(botId: string, input: UpdateBotInput): Promise<UpdateConfigResult> {
    const existing = await this.bots.get(botId);
    if (!existing) return { kind: "not_found", botId };

    // Effective values: an explicitly provided field wins; an omitted field keeps
    // the current row value (partial patch).
    const effectiveGateway = input.gatewayId ?? existing.gateway_id;
    const effectivePersona = input.personaName ?? existing.persona_name;

    // Validate ONLY when the gateway is actually changing (skipped when discovery
    // is unconfigured/unreachable — mirrors provision()).
    if (input.gatewayId !== undefined) {
      const roster = await this.gateways.describe();
      if (roster.status === "ok" && !roster.gateways.includes(effectiveGateway)) {
        return { kind: "unknown_gateway", gatewayId: effectiveGateway, known: roster.gateways };
      }
    }

    const now = Date.now();
    const gatewayChanged = effectiveGateway !== existing.gateway_id;
    // A gateway change is pushed LIVE; a persona change needs re-hydration, so it
    // takes the force-restart path instead. (A mapping-less "just restart" is its
    // own action — restart() / POST /bots/:id/restart — not a flag here.)
    const needsRestart = input.personaName !== undefined;

    // Reassignment SAGA: a RUNNING bot whose gateway is ACTUALLY changing, with no
    // restart/persona change, is moved via detach -> attach -> commit so the NEW
    // gateway ends up with a LIVE socket. This avoids the failure where calling
    // reconfigure() (routing swap) ALONE points the loop at a gateway where no
    // socket exists -> silent not_connected. The saga owns the D1 gateway_id
    // commit, so the mapping is NOT pre-written on this path.
    if (existing.status === "running" && gatewayChanged && !needsRestart) {
      return this.reassign(existing, effectiveGateway);
    }

    // All other paths keep the pre-saga behaviour: persist the mapping up front.
    await this.bots.updateMapping(botId, effectiveGateway, effectivePersona, now);

    // Not running => D1-only; the new mapping applies on the next start().
    if (existing.status !== "running") {
      const row = await this.bots.get(botId);
      return { kind: "ok", bot: row ? view(row) : null, restarted: false };
    }

    if (!needsRestart) {
      // Running, no gateway change (same-gateway PATCH) + no restart: a live
      // same-gateway reconfigure preserves the prior contract (no-op-ish swap).
      let rc;
      try {
        rc = await this.runtime.reconfigure(botId, { gatewayId: effectiveGateway });
      } catch (e) {
        // Live push failed, but D1 already holds the new mapping (it applies on the
        // next start()). The bot is still running, so do NOT mark it failed.
        return { kind: "do_error", botId, error: (e as Error).message };
      }
      const row = await this.bots.get(botId);
      // rc.ok === false only in a TOCTOU race (bot stopped between the D1 read and
      // the RPC); still a 200 — the mapping is persisted and applies on next start.
      return { kind: "ok", bot: row ? view(row) : null, restarted: false, reconfigured: rc.ok };
    }

    // Force-restart so start() re-reads the mapping (new gatewayId + re-hydrated
    // persona) into DO run-state.
    let start: StartResult;
    try {
      start = await this.runtime.start(botId, {
        gatewayId: effectiveGateway,
        personaName: effectivePersona ?? undefined,
        force: true,
      });
    } catch (e) {
      await this.bots.setStatus(botId, "failed");
      return { kind: "do_error", botId, error: (e as Error).message };
    }

    await this.bots.setStatus(botId, start.ok ? "running" : "failed");
    const row = await this.bots.get(botId);
    const bot = row ? view(row) : null;
    return start.ok
      ? { kind: "ok", bot, restarted: true, start }
      : { kind: "start_failed", bot, start };
  }

  /**
   * Reassignment saga. Move a RUNNING bot from its current gateway to
   * `toGw` as a durable, crash-observable sequence:
   *
   *   0. requested  — record the target + start clock (gateway_id untouched).
   *   1. detached   — tear the OLD socket down + drop the old gateway's stored copy.
   *   2. attached   — open a socket on the target from the canonical D1 credential.
   *   3. commit     — flip D1 gateway_id + clear the saga, then swap live routing.
   *
   * Two ordering rules encoded in the step order:
   *   - DETACH before ATTACH: never two live sockets on one Telegram account (dual
   *     socket = duplicate inbound + duplicate replies + ban). The cost is a brief
   *     ZERO-LIVE window, backfilled by the gateway's catch-up on attach (the
   *     update cursor is bot-scoped, so it carries over with no migration).
   *   - ATTACH before COMMIT: gateway_id flips only AFTER the new socket is healthy,
   *     so an attach failure rolls back cleanly to the old gateway.
   *
   * Each step is idempotent (disconnect/connect/delete tolerate "already done"), and
   * the D1 `reassign_state` cursor records progress — a crash leaves an OBSERVABLE
   * half-state a (deferred) reconciler can resume, not a silently broken bot.
   */
  private async reassign(existing: BotRow, toGw: string): Promise<UpdateConfigResult> {
    const botId = existing.bot_id;
    const fromGw = existing.gateway_id;

    // The credential quad is canonical on the D1 row. A bot provisioned under real
    // Telegram always has it; guard so an older/partial row fails LOUDLY here rather
    // than half-detaching and then being unable to attach anywhere.
    if (existing.api_id == null || existing.api_hash == null || existing.session_credential == null) {
      return { kind: "do_error", botId, error: "cannot reassign: bot has no stored Telegram credential" };
    }
    const creds = {
      apiId: existing.api_id,
      apiHash: existing.api_hash,
      sessionCredential: existing.session_credential,
    };

    // 0. requested
    await this.bots.beginReassign(botId, toGw, Date.now());

    // 1. detached — best-effort teardown; a disconnect error still advances (a stray
    //    old socket is at worst reaped on that gateway's next restart, and its stored
    //    credential was already deleted by the gateway DO on the disconnect hop).
    await this.connections.disconnect({ gatewayId: fromGw, botId });
    await this.bots.setReassignState(botId, "detached");

    // 2 + 3. attach on the target, then commit + swap routing (shared with the
    //         reconciler's resume path).
    return this.attachAndCommit(botId, fromGw, toGw, creds);
  }

  /**
   * Reassignment saga steps 2 (attach) + 3 (commit), factored out so BOTH the live
   * PATCH path (`reassign`) and the crash reconciler (`resumeReassign`) drive
   * the identical, idempotent tail:
   *   2. attached — open the socket on the target; on failure roll back (re-connect
   *      the OLD gateway best-effort, clear the saga; gateway_id was never moved).
   *   3. commit   — flip D1 gateway_id + clear the saga, THEN swap live routing. If
   *      the routing RPC fails the move is still COMMITTED (D1 + sockets are on toGw),
   *      surfaced as do_error so a same-gateway re-drive just re-runs reconfigure.
   * Pre-req: the saga cursor is already at (or past) 'detached' — the OLD socket is
   * gone, so attaching the target never yields two live sockets on one account.
   */
  private async attachAndCommit(
    botId: string,
    fromGw: string,
    toGw: string,
    creds: { apiId: number; apiHash: string; sessionCredential: string },
  ): Promise<UpdateConfigResult> {
    const conn = await this.connections.connect({ gatewayId: toGw, botId, ...creds });
    if (!conn.ok) {
      await this.connections.connect({ gatewayId: fromGw, botId, ...creds }).catch(() => {});
      await this.bots.clearReassign(botId);
      return { kind: "connection_failed", botId, error: conn.error };
    }
    await this.bots.setReassignState(botId, "attached");

    await this.bots.commitReassign(botId, toGw, Date.now());
    try {
      const rc = await this.runtime.reconfigure(botId, { gatewayId: toGw });
      const row = await this.bots.get(botId);
      return { kind: "ok", bot: row ? view(row) : null, restarted: false, reconfigured: rc.ok };
    } catch (e) {
      return { kind: "do_error", botId, error: (e as Error).message };
    }
  }

  /**
   * Reconciler — resume ONE stuck saga from its recorded cursor. A
   * crash between saga steps leaves an OBSERVABLE half-state (reassign_state set);
   * this drives it to a terminal state (committed on the target, or rolled back to
   * the source) using the same idempotent steps as the live path:
   *
   *   requested  — nothing torn down yet (old socket still live on fromGw). Detach
   *                the old socket, mark 'detached', then attach+commit the target.
   *   detached   — old socket gone (zero-live window). Attach+commit the target.
   *   attached   — target socket already live, only D1/routing unflipped. Commit +
   *                swap routing (no re-attach — avoids a needless socket rebuild).
   *
   * fromGw = the row's CURRENT gateway_id (commit hasn't moved it yet); toGw = the
   * recorded reassign_target_gw. Missing either the target or the credential quad is
   * unrecoverable → clear the saga and report it (leaves the bot on fromGw).
   */
  private async resumeReassign(row: BotRow): Promise<UpdateConfigResult> {
    const botId = row.bot_id;
    const fromGw = row.gateway_id;
    const toGw = row.reassign_target_gw;
    if (!toGw) {
      await this.bots.clearReassign(botId);
      return { kind: "do_error", botId, error: "stuck saga has no target gateway; cleared" };
    }
    if (row.api_id == null || row.api_hash == null || row.session_credential == null) {
      await this.bots.clearReassign(botId);
      return { kind: "do_error", botId, error: "stuck saga has no stored credential; cleared" };
    }
    const creds = { apiId: row.api_id, apiHash: row.api_hash, sessionCredential: row.session_credential };

    switch (row.reassign_state) {
      case "requested":
        await this.connections.disconnect({ gatewayId: fromGw, botId });
        await this.bots.setReassignState(botId, "detached");
        return this.attachAndCommit(botId, fromGw, toGw, creds);
      case "detached":
        return this.attachAndCommit(botId, fromGw, toGw, creds);
      case "attached":
        // Socket already live on toGw; just finish commit + routing swap.
        await this.bots.commitReassign(botId, toGw, Date.now());
        try {
          const rc = await this.runtime.reconfigure(botId, { gatewayId: toGw });
          const r = await this.bots.get(botId);
          return { kind: "ok", bot: r ? view(r) : null, restarted: false, reconfigured: rc.ok };
        } catch (e) {
          return { kind: "do_error", botId, error: (e as Error).message };
        }
      default:
        await this.bots.clearReassign(botId);
        return { kind: "do_error", botId, error: `unknown reassign_state; cleared` };
    }
  }

  /**
   * Reconciler sweep — resume every saga stuck longer than
   * `timeoutMs`. Driven by the FM cron `scheduled` handler. Best-effort per bot: one
   * bot's failure never blocks the rest. Returns a compact per-bot summary for the
   * scheduled log (no secrets).
   */
  async reconcileStuckSagas(timeoutMs: number): Promise<ReconcileSagasResult> {
    const stuck = await this.bots.listStuckReassigns(Date.now() - timeoutMs);
    const results: ReconcileSagaOutcome[] = [];
    for (const row of stuck) {
      const fromState = row.reassign_state;
      try {
        const r = await this.resumeReassign(row);
        results.push({ botId: row.bot_id, fromState, kind: r.kind });
      } catch (e) {
        results.push({ botId: row.bot_id, fromState, kind: "error", error: (e as Error).message });
      }
    }
    return { swept: stuck.length, results };
  }

  /**
   * Health-probe reconcile — heal bots that D1 says are RUNNING
   * but whose gateway container has NO live socket for them (a silent dead socket:
   * crash/network drop with no restart, so onStart never fired). For each gateway
   * with running bots, probe the container's live connection set; any running bot
   * absent from it (and NOT mid-reassign) is re-connected from its canonical D1
   * credential. A gateway we can't probe is SKIPPED (don't thrash a container that
   * is down/restarting — its own onStart recovery owns that case).
   */
  async reconcileConnections(): Promise<ReconcileConnectionsResult> {
    const rows = await this.bots.list();
    // Only steady-state running bots; a bot mid-reassign is owned by the saga
    // reconciler, not this probe (its socket is intentionally moving).
    const running = rows.filter((r) => r.status === "running" && r.reassign_state == null);

    const byGw = new Map<string, BotRow[]>();
    for (const r of running) {
      const list = byGw.get(r.gateway_id) ?? [];
      list.push(r);
      byGw.set(r.gateway_id, list);
    }

    const results: ReconcileConnectionOutcome[] = [];
    for (const [gatewayId, bots] of byGw) {
      const status = await this.connections.status(gatewayId);
      // Derive traffic light #2 "actual" health from the SAME probe call:
      //   unreachable            -> degraded  (container down)
      //   reachable, has sockets -> active    (channels live)
      //   reachable, no sockets  -> inactive  (up but all channels dark)
      // Best-effort persist: a write failure must not abort the heal loop (the
      // sweep re-runs in 5 min), so it is swallowed.
      const health: GatewayHealth = !status.ok
        ? "degraded"
        : status.connected.length > 0
          ? "active"
          : "inactive";
      await this.gatewayStore.recordProbe(gatewayId, health).catch(() => {});
      if (!status.ok) {
        results.push({ gatewayId, kind: "gateway_unreachable", error: status.error });
        continue;
      }
      const connected = new Set(status.connected);
      for (const b of bots) {
        if (connected.has(b.bot_id)) {
          // Healthy — socket is live. Self-heal a stale red light #4: only WRITE if
          // an error was actually recorded (avoid a needless UPDATE every sweep).
          if (b.last_conn_error != null) await this.bots.clearConnError(b.bot_id).catch(() => {});
          continue;
        }
        if (b.api_id == null || b.api_hash == null || b.session_credential == null) {
          results.push({ gatewayId, botId: b.bot_id, kind: "no_credential" });
          continue;
        }
        const conn = await this.connections.connect({
          gatewayId,
          botId: b.bot_id,
          apiId: b.api_id,
          apiHash: b.api_hash,
          sessionCredential: b.session_credential,
        });
        // Persist the per-bot connect outcome so traffic light #4 reflects a KNOWN
        // failure (AUTH_KEY_DUPLICATED / session_unauthorized) as red, not gray. This
        // was previously discarded to logs only. Best-effort: a D1 write failure must
        // not abort the heal loop (the sweep re-runs in 5 min), so it is swallowed.
        if (conn.ok) {
          if (b.last_conn_error != null) await this.bots.clearConnError(b.bot_id).catch(() => {});
        } else {
          await this.bots.recordConnError(b.bot_id, conn.error).catch(() => {});
        }
        results.push({
          gatewayId,
          botId: b.bot_id,
          kind: conn.ok ? "reconnected" : "reconnect_failed",
          ...(conn.ok ? {} : { error: conn.error }),
        });
      }
    }
    return { gateways: byGw.size, running: running.length, results };
  }

  /** GET /bots — list registry rows; when live, also fan out DO stats() per bot. */
  async list(live: boolean): Promise<ListResult> {
    const rows = await this.bots.list();
    if (!live) return { count: rows.length, bots: rows.map(view) };

    const bots = await Promise.all(
      rows.map(async (row) => {
        let stats: StatsOrError;
        try {
          stats = await this.runtime.stats(row.bot_id);
        } catch (e) {
          stats = { error: (e as Error).message };
        }
        return { ...view(row), stats };
      }),
    );
    return { count: bots.length, bots };
  }

  /** GET /bots/:id — one row + live stats. */
  async getOne(botId: string): Promise<GetOneResult> {
    const row = await this.bots.get(botId);
    if (!row) return { kind: "not_found", botId };
    let stats: StatsOrError;
    try {
      stats = await this.runtime.stats(botId);
    } catch (e) {
      stats = { error: (e as Error).message };
    }
    return { kind: "ok", bot: view(row), stats };
  }

  /** POST /bots/:id/stop — stop the DO loop + mark the row stopped. */
  async stop(botId: string): Promise<StopResultOut> {
    const row = await this.bots.get(botId);
    if (!row) return { kind: "not_found", botId };
    const stop = await this.runtime.stop(botId);
    await this.bots.setStatus(botId, "stopped");
    return { kind: "ok", botId, stop };
  }

  /**
   * POST /bots/:id/restart — force a fresh run of a RUNNING bot, reusing its
   * CURRENT D1 mapping (gateway + persona). start(force:true) resets the DO run:
   * cursor 0, counters reset, new poll window. This is the imperative sibling of
   * stop() — it does NOT change the mapping (that is PATCH's job); it only recycles
   * the run. It intentionally does NOT re-establish the gateway socket, matching the
   * old restart path (the socket outlives a poll-loop restart on a running bot).
   *
   * Restricted to RUNNING bots: restarting an intentionally-stopped bot would need
   * to also re-bind its gateway connection, so a non-running bot is a 409 rather
   * than a silent resurrection. Mirrors the force-restart tail of updateConfig.
   */
  async restart(botId: string): Promise<RestartResult> {
    const row = await this.bots.get(botId);
    if (!row) return { kind: "not_found", botId };
    if (row.status !== "running") return { kind: "not_running", botId };

    let start: StartResult;
    try {
      start = await this.runtime.start(botId, {
        gatewayId: row.gateway_id,
        personaName: row.persona_name ?? undefined,
        force: true,
      });
    } catch (e) {
      await this.bots.setStatus(botId, "failed");
      return { kind: "do_error", botId, error: (e as Error).message };
    }

    await this.bots.setStatus(botId, start.ok ? "running" : "failed");
    const r = await this.bots.get(botId);
    const bot = r ? view(r) : null;
    return start.ok ? { kind: "ok", bot, start } : { kind: "start_failed", bot, start };
  }

  /** DELETE /bots/:id — best-effort stop the DO, then drop the registry row. */
  async remove(botId: string): Promise<RemoveResult> {
    const row = await this.bots.get(botId);
    if (!row) return { kind: "not_found", botId };
    try {
      await this.runtime.stop(botId);
    } catch {
      /* best-effort: still remove the row */
    }
    await this.bots.delete(botId);
    return { kind: "ok", botId };
  }
}
