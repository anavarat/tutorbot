/**
 * Cross-script contract for the BotFleetDO RPC surface + its stats snapshot.
 *
 * Single source of truth shared by:
 *   - bot-fleet     — the DO `implements BotFleetMethods`, so any drift between
 *                     the class and this contract is a COMPILE error there.
 *   - fleet-manager — types its `DurableObjectNamespace<BotFleetRpc>` stub.
 *
 * Pure types only: no runtime code and no `pg` / `cloudflare:workers` imports,
 * so both workers import it with `import type` and esbuild elides it entirely
 * (nothing from this package ends up in either bundle).
 */

/** Options accepted by BotFleetDO.start(). */
export interface StartOpts {
  botId: string;
  /** The gateway/container this bot attaches to, e.g. "gw-1". Stored in DO run-state on start(). */
  gatewayId: string;
  /**
   * Display name of the persona to give this bot's replies (e.g. "Tanya Alexander"),
   * resolved against the Postgres `persona` catalog at start(). Optional => backward
   * compatible: when absent the DO uses the default (fallback) prompt. Only the
   * name crosses this RPC boundary; the persona object is hydrated DO-side so this
   * shared contract stays free of `pg`/DB types.
   */
  personaName?: string;
  runMinutes?: number;
  force?: boolean;
}

/** BotFleetDO.start() result. */
export interface StartResult {
  ok: boolean;
  reason?: string;
  botId?: string | null;
  startedAt?: number;
  nextAlarm?: number | null;
}

/**
 * Options accepted by BotFleetDO.reconfigure() — LIVE config knobs that can change
 * mid-run WITHOUT restarting the poll loop. Gateway-only for now: a persona change
 * still goes through a force-restart via start() (it needs a DB re-hydration and we
 * deliberately did NOT build a non-disruptive persona path).
 */
export interface ReconfigureOpts {
  /**
   * New gateway/container to attach to, e.g. "gw-2". Written straight into DO
   * run-state; the next already-scheduled poll picks it up (delivery reads
   * gatewayId LIVE per wake), so the cursor / jitter cadence / counters are left
   * untouched — unlike start({force:true}), which resets the whole run.
   */
  gatewayId: string;
}

/** BotFleetDO.reconfigure() result. */
export interface ReconfigureResult {
  ok: boolean;
  /** Set when ok=false, e.g. "not running" (a stopped bot cannot be live-reconfigured). */
  reason?: string;
  botId?: string | null;
  /** The gatewayId now in run-state (the new one on success). */
  gatewayId?: string | null;
  /** The (unchanged) next poll time — reconfigure does NOT reschedule. */
  nextAlarm?: number | null;
}

/** BotFleetDO.stop() result. */
export interface StopResult {
  ok: true;
  botId: string | null;
  count: number;
}

/** RPC-serializable counters snapshot returned by BotFleetDO.stats(). */
export interface BotStats {
  botId: string | null;
  count: number;
  cursor: number;
  rowsTotal: number;
  runMinutes: number;
  startedAt: number | null;
  lastTs: number | null;
  stoppedAt: number | null;
  lastDelayMs: number | null;
  nextAlarm: number | null;
  elapsedMin: number | null;
}

/**
 * The DO's public method surface. The DO class `implements` this (NOT the
 * branded variant below), which is why it carries no phantom brand: a plain
 * class extending `DurableObject` can satisfy it without brand gymnastics.
 */
export interface BotFleetMethods {
  start(opts: StartOpts): Promise<StartResult>;
  reconfigure(opts: ReconfigureOpts): Promise<ReconfigureResult>;
  stop(): Promise<StopResult>;
  stats(): Promise<BotStats>;
}

/**
 * Client-facing stub type used by fleet-manager. Extends the workers-types
 * phantom brand `Rpc.DurableObjectBranded` so it satisfies the
 * `DurableObjectNamespace<T>` / `DurableObjectStub<T>` constraint. The brand is
 * a compile-time marker only — no instance is ever constructed on the client;
 * the runtime hands back the real cross-script stub.
 */
export interface BotFleetRpc extends Rpc.DurableObjectBranded, BotFleetMethods {}
