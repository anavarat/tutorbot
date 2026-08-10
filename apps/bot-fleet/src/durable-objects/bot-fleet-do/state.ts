/**
 * The bot's durable run-state, OWNED BY THE AGENTS SDK. The Agent persists this
 * whole object to its embedded SQLite (`cf_agents_state`) on every
 * `this.setState()` and rehydrates it into `this.state` on each activation (wake).
 * One instance == one bot.
 *
 * REDUCED (teaching) shape: the poll loop is a plain fixed-interval wake ->
 * discover -> canned reply -> deliver. There is no jitter, no active-hours
 * schedule, no ban-guard, and no outbox work-queue, so those fields are gone.
 *
 * Declared as a `type` (not an `interface`) so it satisfies the Agents `State`
 * generic without index-signature friction.
 */
import type { PersonaPrompt } from "../../domain/reply/persona";

export type RunPhase = "idle" | "running" | "stopped";

export type RunState = {
  /** Which bot this instance polls (addressed via getByName("bot-N")); null until start(). */
  botId: string | null;
  /** The gateway/container this bot attaches to (e.g. "gw-1"); null until start(). Read live each wake. */
  gatewayId: string | null;
  /** Assigned persona's display name; null => generic tutor voice. */
  personaName: string | null;
  /** The persona's voice, hydrated ONCE at start() from the `persona` catalog and cached here. */
  persona: PersonaPrompt | null;
  /** Lifecycle: idle (never started) -> running -> stopped. */
  phase: RunPhase;
  /** Poll wakes so far this run. */
  count: number;
  /** High-watermark message id cursor (last inbound processed). */
  cursor: number;
  /** Cumulative inbound rows seen this run. */
  rowsTotal: number;
  /** Replies persisted this run. */
  repliesTotal: number;
  /** id of the last inbound message we replied to (write-back marker); null if none yet. */
  lastReplyId: number | null;
  /** Run start epoch ms; null until start(). */
  startedAt: number | null;
  /** Last poll epoch ms. */
  lastTs: number | null;
  /** Stop epoch ms; null until stopped. */
  stoppedAt: number | null;
  /** When the next poll is scheduled (epoch ms). Mirrors the SDK schedule/alarm. */
  nextPollAt: number | null;
  /** Run-scoped correlation id, minted once per start() so every wake logs the same request_id. */
  runId: string | null;
};

/** Fresh run-state: idle, zeroed counters, no markers. Spread + override in start(). */
export const INITIAL_RUN_STATE: RunState = {
  botId: null,
  gatewayId: null,
  personaName: null,
  persona: null,
  phase: "idle",
  count: 0,
  cursor: 0,
  rowsTotal: 0,
  repliesTotal: 0,
  lastReplyId: null,
  startedAt: null,
  lastTs: null,
  stoppedAt: null,
  nextPollAt: null,
  runId: null,
};
