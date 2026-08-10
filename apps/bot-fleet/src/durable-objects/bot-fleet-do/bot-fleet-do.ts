import { Agent } from "agents";
import type {
  BotFleetMethods,
  BotStats,
  ReconfigureOpts,
  ReconfigureResult,
  StartOpts,
  StartResult,
  StopResult,
} from "@tutorbot/shared/rpc";
import { buildReplyKey } from "@tutorbot/shared";
import { createStageLogger } from "@tutorbot/shared/observability";
import type { BotFleetEnv } from "../../types";
import { discoverBotMessages, recordSentMessage } from "../../platform/hyperdrive/message-repo";
import { getPersonaByName } from "../../platform/hyperdrive/persona-repo";
import { cannedReply } from "../../domain/reply/canned";
import { deliverReplyToGateway } from "../../platform/gateway/gateway-client";
import { INITIAL_RUN_STATE, type RunState } from "./state";

/** Name of the scheduled callback that drives the poll loop (see pollOnce). */
const POLL_CALLBACK = "pollOnce";

/** Default seconds between poll wakes when POLL_INTERVAL_SEC is unset. */
const DEFAULT_POLL_INTERVAL_SEC = 30;

/** Resolve the fixed poll interval (ms) from env, clamped to a sane floor. */
function pollIntervalMs(env: BotFleetEnv): number {
  const secs = Number(env.POLL_INTERVAL_SEC ?? DEFAULT_POLL_INTERVAL_SEC);
  const safe = Number.isFinite(secs) && secs >= 5 ? secs : DEFAULT_POLL_INTERVAL_SEC;
  return safe * 1000;
}

/**
 * Per-bot poller, built on the Agents SDK long-running-agent pattern. One Agent
 * instance == one bot (addressed by getByName("bot-N")). It hibernates at ~0
 * compute between wakes; a self-scheduled alarm wakes it on a FIXED interval.
 *
 * REDUCED (teaching) reply loop — each wake:
 *   1. DISCOVER new inbound messages via Hyperdrive (high-watermark cursor).
 *   2. REPLY to each with a deterministic, per-persona CANNED line (no model).
 *   3. PERSIST each reply as an outbound `message` row + DELIVER it to the gateway
 *      (best-effort; the row is the durable record).
 *   4. RESCHEDULE the next wake and hibernate.
 *
 * There is no jitter, no active-hours schedule, no ban-guard, no durable fiber,
 * and no outbox work-queue — those belong to the full data plane. `implements
 * BotFleetMethods` binds start()/reconfigure()/stop()/stats() to the shared RPC
 * contract that fleet-manager calls (native Durable Object RPC).
 */
export class BotFleetDO extends Agent<BotFleetEnv, RunState> implements BotFleetMethods {
  initialState: RunState = INITIAL_RUN_STATE;

  /** Begin the poll loop for a given bot. Idempotent unless force=true. */
  async start(opts: StartOpts): Promise<StartResult> {
    if (this.state.phase === "running" && !opts.force) {
      return {
        ok: false,
        reason: "already running",
        botId: this.state.botId,
        nextAlarm: this.state.nextPollAt,
      };
    }
    // force-restart safety: drop any existing scheduled poll so we never run two loops.
    await this.cancelAllPolls();

    const startedAt = Date.now();
    const runId = `run_${crypto.randomUUID()}`;
    const log = createStageLogger({
      context: { svc: "bot-fleet", botId: opts.botId, gatewayId: opts.gatewayId },
      correlation: { request_id: runId },
    });

    // Hydrate the assigned persona ONCE per run (static catalog data, cached in
    // RunState). A miss/error => null => generic tutor voice.
    const persona = opts.personaName
      ? await getPersonaByName(this.env.HYPERDRIVE.connectionString, opts.personaName)
      : null;
    if (opts.personaName && !persona) {
      log.warn("persona.fallback", "assigned persona not found; using generic voice", {
        personaName: opts.personaName,
      });
    }

    const nextPollAt = startedAt + pollIntervalMs(this.env);
    this.setState({
      ...INITIAL_RUN_STATE,
      botId: opts.botId,
      gatewayId: opts.gatewayId,
      personaName: opts.personaName ?? null,
      persona,
      phase: "running",
      startedAt,
      nextPollAt,
      runId,
    });
    await this.schedule(new Date(nextPollAt), POLL_CALLBACK);

    log.info("loop.start", "bot poll loop started", { nextPollAt });
    return { ok: true, botId: opts.botId, startedAt, nextAlarm: nextPollAt };
  }

  /**
   * LIVE gateway swap — mutate the attached gatewayId in run-state WITHOUT
   * restarting the loop. `gatewayId` is read fresh from `this.state` on every wake,
   * so the next already-scheduled poll simply delivers to the new gateway.
   */
  async reconfigure(opts: ReconfigureOpts): Promise<ReconfigureResult> {
    const s = this.state;
    if (s.phase !== "running") {
      return { ok: false, reason: "not running", botId: s.botId, gatewayId: s.gatewayId };
    }
    const previous = s.gatewayId;
    this.setState({ ...s, gatewayId: opts.gatewayId });

    const context: Record<string, unknown> = { svc: "bot-fleet", gatewayId: opts.gatewayId };
    if (s.botId) context.botId = s.botId;
    createStageLogger({
      context,
      correlation: s.runId ? { request_id: s.runId } : undefined,
    }).info("loop.reconfigure", "gateway reassigned live (no restart)", {
      previousGatewayId: previous,
      gatewayId: opts.gatewayId,
    });

    return { ok: true, botId: s.botId, gatewayId: opts.gatewayId, nextAlarm: s.nextPollAt };
  }

  /**
   * Scheduled callback: one Hyperdrive->Postgres cursor poll, a canned reply per
   * new inbound message, then reschedule the next poll and hibernate. Best-effort:
   * a DB or delivery error is logged, and the loop keeps its cadence.
   */
  async pollOnce(): Promise<void> {
    const s = this.state;
    const now = Date.now();
    const botId = s.botId;

    const context: Record<string, unknown> = { svc: "bot-fleet" };
    if (botId) context.botId = botId;
    if (s.gatewayId) context.gatewayId = s.gatewayId;
    const log = createStageLogger({
      context,
      correlation: s.runId ? { request_id: s.runId } : undefined,
    });

    if (s.phase !== "running" || !botId) return; // safety: stopped/never-started

    const conn = this.env.HYPERDRIVE.connectionString;

    // (1) DISCOVER new inbound.
    const poll = await discoverBotMessages(conn, botId, s.cursor);
    if (poll.dbErr) {
      log.warn("loop.discover", "discover query failed", { error: poll.dbErr, dbMs: poll.dbMs });
    } else if (poll.rows > 0) {
      log.info("loop.discover", "discovered inbound messages", {
        rows: poll.rows,
        newCursor: poll.newCursor,
      });
    }

    // (2+3) REPLY + PERSIST + DELIVER, one canned line per new inbound.
    let repliesTotal = s.repliesTotal;
    let lastReplyId = s.lastReplyId;
    let persistFailed = false;
    for (const m of poll.messages) {
      const replyKey = buildReplyKey(m.idempotencyKey);
      const content = cannedReply(s.persona, m.content);
      const sent = await recordSentMessage(conn, botId, m.chatId, replyKey, content);
      if (sent.dbErr) {
        persistFailed = true;
        log.error("db.error", "reply insert failed", { error: sent.dbErr, chatId: m.chatId });
        break; // hold the cursor; retry this batch next wake
      }
      if (!sent.duplicate) {
        repliesTotal += 1;
        await deliverReplyToGateway(this.env, s.gatewayId, botId, m.id, content, replyKey);
      }
      lastReplyId = m.id;
    }

    // (4) SCHEDULE next wake + WRITE-BACK. Hold the cursor on a persist failure so
    // the batch is re-discovered and retried (dedup-safe on the deterministic key).
    const cursor = persistFailed ? s.cursor : poll.newCursor;
    const rowsTotal = persistFailed ? s.rowsTotal : s.rowsTotal + poll.rows;
    const nextPollAt = now + pollIntervalMs(this.env);
    this.setState({
      ...s,
      count: s.count + 1,
      cursor,
      rowsTotal,
      repliesTotal,
      lastReplyId,
      lastTs: now,
      nextPollAt,
    });
    await this.schedule(new Date(nextPollAt), POLL_CALLBACK);
    log.debug("alarm.set", "next poll scheduled", {
      count: s.count + 1,
      rows: poll.rows,
      cursor,
      repliesTotal,
      nextPollAt,
    });
  }

  /** Read counters without disturbing the loop. */
  async stats(): Promise<BotStats> {
    const s = this.state;
    return {
      botId: s.botId,
      count: s.count,
      cursor: s.cursor,
      rowsTotal: s.rowsTotal,
      runMinutes: 0, // no wall-clock cap in the teaching build (kept for contract)
      startedAt: s.startedAt,
      lastTs: s.lastTs,
      stoppedAt: s.stoppedAt,
      lastDelayMs: pollIntervalMs(this.env),
      nextAlarm: s.nextPollAt,
      elapsedMin: s.startedAt ? Math.round((Date.now() - s.startedAt) / 60_000) : null,
    };
  }

  /** Stop the loop and stamp the stop. */
  async stop(): Promise<StopResult> {
    const s = this.state;
    await this.cancelAllPolls();
    this.setState({ ...s, phase: "stopped", stoppedAt: Date.now(), nextPollAt: null });

    const context: Record<string, unknown> = { svc: "bot-fleet" };
    if (s.botId) context.botId = s.botId;
    if (s.gatewayId) context.gatewayId = s.gatewayId;
    createStageLogger({
      context,
      correlation: s.runId ? { request_id: s.runId } : undefined,
    }).info("loop.stop", "run ended (manual stop)", {
      count: s.count,
      rowsTotal: s.rowsTotal,
      repliesTotal: s.repliesTotal,
    });

    return { ok: true, botId: s.botId, count: s.count };
  }

  /**
   * Cancel every scheduled callback so the loop stops. Cancelling ALL schedules
   * ensures stop()/force-restart never leave an orphaned poll alarm running.
   */
  private async cancelAllPolls(): Promise<void> {
    for (const sched of await this.listSchedules()) {
      await this.cancelSchedule(sched.id);
    }
  }
}
