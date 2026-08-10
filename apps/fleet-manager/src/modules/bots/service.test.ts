import { describe, expect, it } from "vitest";

import { BotService } from "./service";
import type { BotsDao, BotRow, TelegramCreds } from "../../platform/persistence/bots-dao";
import type { GatewaysDao } from "../../platform/persistence/gateways-dao";
import type { BotRuntime } from "../../platform/botfleet/bot-runtime";
import type { GatewayDirectory, GatewayListResult } from "../../platform/gateway/gateway-directory";
import type {
  GatewayConnections,
  GatewayConnectionInput,
  GatewayConnectionResult,
  GatewayDisconnectInput,
  GatewayDisconnectResult,
  GatewayStatusResult,
} from "../../platform/gateway/gateway-connection";
import type {
  BotStats,
  ReconfigureOpts,
  ReconfigureResult,
  StartOpts,
  StartResult,
  StopResult,
} from "@tutorbot/shared/rpc";

// ---- fakes ---------------------------------------------------------------

/** In-memory stand-in for BotsDao (cast through `unknown` — real DAO has a
 *  `private db` so it is not structurally assignable). */
class FakeBotsDao {
  rows = new Map<string, BotRow>();
  counter = 0;

  seed(row: Partial<BotRow> & { bot_id: string }): this {
    this.rows.set(row.bot_id, {
      bot_id: row.bot_id,
      gateway_id: row.gateway_id ?? "gw-1",
      persona_name: row.persona_name ?? null,
      status: row.status ?? "running",
      created_at: row.created_at ?? 1000,
      updated_at: row.updated_at ?? 1000,
      api_id: row.api_id ?? null,
      api_hash: row.api_hash ?? null,
      phone: row.phone ?? null,
      session_credential: row.session_credential ?? null,
      reassign_target_gw: row.reassign_target_gw ?? null,
      reassign_state: row.reassign_state ?? null,
      reassign_started_at: row.reassign_started_at ?? null,
      last_conn_error: row.last_conn_error ?? null,
      last_conn_error_at: row.last_conn_error_at ?? null,
    });
    return this;
  }

  async nextBotId(): Promise<string> {
    return `bot-${++this.counter}`;
  }
  async get(botId: string): Promise<BotRow | null> {
    return this.rows.get(botId) ?? null;
  }
  async list(): Promise<BotRow[]> {
    return [...this.rows.values()];
  }
  async upsertProvisioning(
    botId: string,
    gatewayId: string,
    personaName: string | null,
    creds: TelegramCreds,
    now: number,
  ): Promise<void> {
    const existing = this.rows.get(botId);
    this.rows.set(botId, {
      bot_id: botId,
      gateway_id: gatewayId,
      persona_name: personaName,
      status: "provisioning",
      created_at: existing?.created_at ?? now,
      updated_at: now,
      api_id: creds.apiId,
      api_hash: creds.apiHash,
      phone: creds.phone,
      session_credential: creds.sessionCredential,
      reassign_target_gw: existing?.reassign_target_gw ?? null,
      reassign_state: existing?.reassign_state ?? null,
      reassign_started_at: existing?.reassign_started_at ?? null,
      last_conn_error: existing?.last_conn_error ?? null,
      last_conn_error_at: existing?.last_conn_error_at ?? null,
    });
  }
  async updateMapping(
    botId: string,
    gatewayId: string,
    personaName: string | null,
    now = Date.now(),
  ): Promise<void> {
    const r = this.rows.get(botId);
    if (!r) return;
    this.rows.set(botId, { ...r, gateway_id: gatewayId, persona_name: personaName, updated_at: now });
  }
  async setStatus(botId: string, status: string, now = Date.now()): Promise<void> {
    const r = this.rows.get(botId);
    if (!r) return;
    this.rows.set(botId, { ...r, status, updated_at: now });
  }
  connErrCalls: Array<{ botId: string; error: string | null }> = [];
  async recordConnError(botId: string, error: string): Promise<void> {
    this.connErrCalls.push({ botId, error });
    const r = this.rows.get(botId);
    if (r) this.rows.set(botId, { ...r, last_conn_error: error, last_conn_error_at: Date.now() });
  }
  async clearConnError(botId: string): Promise<void> {
    this.connErrCalls.push({ botId, error: null });
    const r = this.rows.get(botId);
    if (r) this.rows.set(botId, { ...r, last_conn_error: null, last_conn_error_at: null });
  }
  async beginReassign(botId: string, targetGw: string, startedAt: number): Promise<void> {
    const r = this.rows.get(botId);
    if (!r) return;
    this.rows.set(botId, {
      ...r,
      reassign_target_gw: targetGw,
      reassign_state: "requested",
      reassign_started_at: startedAt,
      updated_at: startedAt,
    });
  }
  async setReassignState(botId: string, state: BotRow["reassign_state"], now = Date.now()): Promise<void> {
    const r = this.rows.get(botId);
    if (!r) return;
    this.rows.set(botId, { ...r, reassign_state: state, updated_at: now });
  }
  async commitReassign(botId: string, newGatewayId: string, now = Date.now()): Promise<void> {
    const r = this.rows.get(botId);
    if (!r) return;
    this.rows.set(botId, {
      ...r,
      gateway_id: newGatewayId,
      reassign_target_gw: null,
      reassign_state: null,
      reassign_started_at: null,
      updated_at: now,
    });
  }
  async clearReassign(botId: string, now = Date.now()): Promise<void> {
    const r = this.rows.get(botId);
    if (!r) return;
    this.rows.set(botId, {
      ...r,
      reassign_target_gw: null,
      reassign_state: null,
      reassign_started_at: null,
      updated_at: now,
    });
  }
  async delete(botId: string): Promise<void> {
    this.rows.delete(botId);
  }
  async countOnGateway(gatewayId: string): Promise<number> {
    return [...this.rows.values()].filter((r) => r.gateway_id === gatewayId).length;
  }
  async listStuckReassigns(startedBefore: number): Promise<BotRow[]> {
    return [...this.rows.values()]
      .filter(
        (r) =>
          r.reassign_state != null && r.reassign_started_at != null && r.reassign_started_at < startedBefore,
      )
      .sort((a, b) => (a.reassign_started_at ?? 0) - (b.reassign_started_at ?? 0));
  }
}

class FakeRuntime implements BotRuntime {
  startCalls: Array<{ botId: string } & Omit<StartOpts, "botId">> = [];
  reconfigureCalls: Array<{ botId: string; opts: ReconfigureOpts }> = [];
  stopCalls: string[] = [];
  statsCalls: string[] = [];

  startResult: StartResult = { ok: true, startedAt: 123 };
  reconfigureResult: ReconfigureResult = { ok: true, gatewayId: "gw-2" };
  startError: Error | null = null;
  reconfigureError: Error | null = null;

  async start(botId: string, opts: Omit<StartOpts, "botId">): Promise<StartResult> {
    this.startCalls.push({ botId, ...opts });
    if (this.startError) throw this.startError;
    return this.startResult;
  }
  async reconfigure(botId: string, opts: ReconfigureOpts): Promise<ReconfigureResult> {
    this.reconfigureCalls.push({ botId, opts });
    if (this.reconfigureError) throw this.reconfigureError;
    return this.reconfigureResult;
  }
  async stop(botId: string): Promise<StopResult> {
    this.stopCalls.push(botId);
    return { ok: true, botId, count: 0 };
  }
  async stats(botId: string): Promise<BotStats> {
    this.statsCalls.push(botId);
    return {
      botId,
      count: 0,
      cursor: 0,
      rowsTotal: 0,
      runMinutes: 0,
      startedAt: null,
      lastTs: null,
      stoppedAt: null,
      lastDelayMs: null,
      nextAlarm: null,
      elapsedMin: null,
    };
  }
}

class FakeDirectory implements GatewayDirectory {
  calls = 0;
  constructor(public result: GatewayListResult) {}
  async describe(): Promise<GatewayListResult> {
    this.calls++;
    return this.result;
  }
}

/**
 * Records connect()/disconnect() calls in ARRIVAL ORDER (shared `calls` log) so a
 * test can assert detach-before-attach. `result` is the connect outcome (default =
 * a happy identity); `connectResults` optionally overrides per-call (FIFO) so the
 * saga's target-connect can fail while the rollback re-connect succeeds.
 */
class FakeGatewayConnections implements GatewayConnections {
  connectCalls: GatewayConnectionInput[] = [];
  disconnectCalls: GatewayDisconnectInput[] = [];
  /** Ordered trace across both verbs, e.g. ["disconnect:gw-1", "connect:gw-2"]. */
  calls: string[] = [];
  result: GatewayConnectionResult = {
    ok: true,
    identity: { id: "111", username: "bot_user", phone: "+447700900000" },
  };
  connectResults: GatewayConnectionResult[] = [];
  disconnectResult: GatewayDisconnectResult = { ok: true };
  /** Per-gateway probe result for status(); default = reachable, empty set. */
  statusByGw: Record<string, GatewayStatusResult> = {};
  statusCalls: string[] = [];

  async connect(input: GatewayConnectionInput): Promise<GatewayConnectionResult> {
    this.connectCalls.push(input);
    this.calls.push(`connect:${input.gatewayId}`);
    return this.connectResults.shift() ?? this.result;
  }
  async disconnect(input: GatewayDisconnectInput): Promise<GatewayDisconnectResult> {
    this.disconnectCalls.push(input);
    this.calls.push(`disconnect:${input.gatewayId}`);
    return this.disconnectResult;
  }
  async status(gatewayId: string): Promise<GatewayStatusResult> {
    this.statusCalls.push(gatewayId);
    return this.statusByGw[gatewayId] ?? { ok: true, connected: [] };
  }
}

/** The credential quad every provision now requires. */
const CREDS = {
  apiId: 123456,
  apiHash: "0123456789abcdef0123456789abcdef",
  phone: "+447700900000",
  sessionCredential: "1AaBbCcStringSession==",
};

/** Minimal GatewaysDao fake — only recordProbe is exercised by the sweep. */
class FakeGatewaysDao {
  probeCalls: Array<{ gatewayId: string; health: string }> = [];
  async recordProbe(gatewayId: string, health: string): Promise<void> {
    this.probeCalls.push({ gatewayId, health });
  }
}

/** Wire a service with the fakes; return them all for assertions. */
function make(roster: GatewayListResult = { status: "ok", gateways: ["gw-1", "gw-2"] }) {
  const bots = new FakeBotsDao();
  const runtime = new FakeRuntime();
  const dir = new FakeDirectory(roster);
  const connections = new FakeGatewayConnections();
  const gatewayStore = new FakeGatewaysDao();
  const svc = new BotService(
    bots as unknown as BotsDao,
    runtime,
    dir,
    connections,
    gatewayStore as unknown as GatewaysDao,
  );
  return { bots, runtime, dir, connections, gatewayStore, svc };
}

// ---- provision -----------------------------------------------------------

describe("BotService.provision", () => {
  it("rejects an unknown gateway without burning an id, a row, or a connect", async () => {
    const { svc, bots, runtime, connections } = make({ status: "ok", gateways: ["gw-1"] });
    const res = await svc.provision({ gatewayId: "gw-9", ...CREDS });
    expect(res).toEqual({ kind: "unknown_gateway", gatewayId: "gw-9", known: ["gw-1"] });
    expect(bots.rows.size).toBe(0);
    expect(runtime.startCalls).toHaveLength(0);
    // gateway is validated BEFORE the connection is touched.
    expect(connections.connectCalls).toHaveLength(0);
  });

  it("auto-allocates bot-N, starts the DO, and marks it running", async () => {
    const { svc, runtime } = make();
    const res = await svc.provision({ gatewayId: "gw-1", ...CREDS });
    if (res.kind !== "ok") throw new Error(`expected ok, got ${res.kind}`);
    expect(res.bot?.bot_id).toBe("bot-1");
    expect(res.bot?.status).toBe("running");
    expect(runtime.startCalls).toHaveLength(1);
    expect(runtime.startCalls[0].botId).toBe("bot-1");
    expect(runtime.startCalls[0].gatewayId).toBe("gw-1");
  });

  it("connects the channel (creds forwarded, persisted) then starts the DO, and returns identity", async () => {
    const { svc, connections, bots } = make();
    const res = await svc.provision({ gatewayId: "gw-1", ...CREDS });
    if (res.kind !== "ok") throw new Error(`expected ok, got ${res.kind}`);
    // connect happened, with the right routing + creds
    expect(connections.connectCalls).toHaveLength(1);
    expect(connections.connectCalls[0]).toMatchObject({
      gatewayId: "gw-1",
      botId: "bot-1",
      apiId: CREDS.apiId,
      apiHash: CREDS.apiHash,
      sessionCredential: CREDS.sessionCredential,
    });
    // identity surfaced
    expect(res.identity.id).toBe("111");
    // creds persisted to the registry row
    expect(bots.rows.get("bot-1")?.api_id).toBe(CREDS.apiId);
    expect(bots.rows.get("bot-1")?.session_credential).toBe(CREDS.sessionCredential);
  });

  it("never leaks secrets in the output view (no session_credential / api_hash)", async () => {
    const { svc } = make();
    const res = await svc.provision({ gatewayId: "gw-1", ...CREDS });
    if (res.kind !== "ok") throw new Error(`expected ok, got ${res.kind}`);
    expect(res.bot && "session_credential" in res.bot).toBe(false);
    expect(res.bot && "api_hash" in res.bot).toBe(false);
    // non-secret identifiers ARE kept
    expect(res.bot?.api_id).toBe(CREDS.apiId);
    expect(res.bot?.phone).toBe(CREDS.phone);
  });

  it("returns connection_failed and marks failed when the container connect fails", async () => {
    const { svc, bots, runtime, connections } = make();
    connections.result = { ok: false, error: "SESSION_REVOKED" };
    const res = await svc.provision({ botId: "bot-1", gatewayId: "gw-1", ...CREDS });
    if (res.kind !== "connection_failed") throw new Error(`expected connection_failed, got ${res.kind}`);
    expect(res.error).toBe("SESSION_REVOKED");
    expect(bots.rows.get("bot-1")?.status).toBe("failed");
    // a bot with no live channel must NOT start polling
    expect(runtime.startCalls).toHaveLength(0);
  });

  it("honours a caller-supplied botId", async () => {
    const { svc } = make();
    const res = await svc.provision({ botId: "bot-custom", gatewayId: "gw-1", ...CREDS });
    if (res.kind !== "ok") throw new Error(`expected ok, got ${res.kind}`);
    expect(res.bot?.bot_id).toBe("bot-custom");
  });

  it("reuses the stored persona when re-provisioning without one", async () => {
    const { svc, bots, runtime } = make();
    bots.seed({ bot_id: "bot-1", persona_name: "Tanya Alexander", status: "stopped" });
    const res = await svc.provision({ botId: "bot-1", gatewayId: "gw-1", ...CREDS });
    if (res.kind !== "ok") throw new Error(`expected ok, got ${res.kind}`);
    expect(runtime.startCalls[0].personaName).toBe("Tanya Alexander");
    expect(bots.rows.get("bot-1")?.persona_name).toBe("Tanya Alexander");
  });

  it("lets an explicit persona override the stored one", async () => {
    const { svc, bots, runtime } = make();
    bots.seed({ bot_id: "bot-1", persona_name: "Old Name", status: "stopped" });
    const res = await svc.provision({ botId: "bot-1", gatewayId: "gw-1", personaName: "New Name", ...CREDS });
    if (res.kind !== "ok") throw new Error(`expected ok, got ${res.kind}`);
    expect(runtime.startCalls[0].personaName).toBe("New Name");
    expect(bots.rows.get("bot-1")?.persona_name).toBe("New Name");
  });

  it("skips gateway validation when discovery is unconfigured", async () => {
    const { svc, runtime } = make({ status: "unconfigured" });
    const res = await svc.provision({ gatewayId: "gw-anything", ...CREDS });
    expect(res.kind).toBe("ok");
    expect(runtime.startCalls).toHaveLength(1);
  });

  it("returns start_failed and marks failed when the DO declines", async () => {
    const { svc, bots, runtime } = make();
    runtime.startResult = { ok: false, reason: "already running" };
    const res = await svc.provision({ botId: "bot-1", gatewayId: "gw-1", ...CREDS });
    if (res.kind !== "start_failed") throw new Error(`expected start_failed, got ${res.kind}`);
    expect(res.bot?.status).toBe("failed");
    expect(bots.rows.get("bot-1")?.status).toBe("failed");
  });

  it("returns do_error and marks failed when the RPC throws", async () => {
    const { svc, bots, runtime } = make();
    runtime.startError = new Error("boom");
    const res = await svc.provision({ botId: "bot-1", gatewayId: "gw-1", ...CREDS });
    expect(res).toEqual({ kind: "do_error", botId: "bot-1", error: "boom" });
    expect(bots.rows.get("bot-1")?.status).toBe("failed");
  });
});

// ---- updateConfig --------------------------------------------------------

describe("BotService.updateConfig", () => {
  it("returns not_found for an unknown bot", async () => {
    const { svc } = make();
    const res = await svc.updateConfig("bot-x", { gatewayId: "gw-2" });
    expect(res).toEqual({ kind: "not_found", botId: "bot-x" });
  });

  it("moves a running bot via the reassignment saga (detach old -> attach new -> commit + reconfigure)", async () => {
    const { svc, bots, runtime, connections } = make();
    bots.seed({
      bot_id: "bot-1",
      gateway_id: "gw-1",
      status: "running",
      api_id: CREDS.apiId,
      api_hash: CREDS.apiHash,
      session_credential: CREDS.sessionCredential,
    });
    const res = await svc.updateConfig("bot-1", { gatewayId: "gw-2" });
    if (res.kind !== "ok") throw new Error(`expected ok, got ${res.kind}`);
    expect(res.restarted).toBe(false);
    expect(res.reconfigured).toBe(true);
    // DETACH old strictly BEFORE ATTACH new (no dual socket on one account).
    expect(connections.calls).toEqual(["disconnect:gw-1", "connect:gw-2"]);
    expect(connections.disconnectCalls[0]).toMatchObject({ gatewayId: "gw-1", botId: "bot-1" });
    expect(connections.connectCalls[0]).toMatchObject({
      gatewayId: "gw-2",
      botId: "bot-1",
      apiId: CREDS.apiId,
      sessionCredential: CREDS.sessionCredential,
    });
    // Routing swapped to the new gateway, mapping committed, saga cleared.
    expect(runtime.reconfigureCalls).toEqual([{ botId: "bot-1", opts: { gatewayId: "gw-2" } }]);
    expect(runtime.startCalls).toHaveLength(0);
    expect(bots.rows.get("bot-1")?.gateway_id).toBe("gw-2");
    expect(bots.rows.get("bot-1")?.reassign_state).toBeNull();
    expect(bots.rows.get("bot-1")?.reassign_target_gw).toBeNull();
  });

  it("rolls back to the old gateway when the target attach fails (no D1 move, saga cleared)", async () => {
    const { svc, bots, runtime, connections } = make();
    bots.seed({
      bot_id: "bot-1",
      gateway_id: "gw-1",
      status: "running",
      api_id: CREDS.apiId,
      api_hash: CREDS.apiHash,
      session_credential: CREDS.sessionCredential,
    });
    // First connect (target gw-2) fails; the rollback re-connect (old gw-1) succeeds.
    connections.connectResults = [
      { ok: false, error: "SESSION_REVOKED" },
      { ok: true, identity: { id: "111", username: "u", phone: null } },
    ];
    const res = await svc.updateConfig("bot-1", { gatewayId: "gw-2" });
    if (res.kind !== "connection_failed") throw new Error(`expected connection_failed, got ${res.kind}`);
    expect(res.error).toBe("SESSION_REVOKED");
    // detach gw-1 -> attach gw-2 (fails) -> rollback re-connect gw-1.
    expect(connections.calls).toEqual(["disconnect:gw-1", "connect:gw-2", "connect:gw-1"]);
    // gateway_id NEVER moved; routing never swapped; saga cursor cleared.
    expect(bots.rows.get("bot-1")?.gateway_id).toBe("gw-1");
    expect(bots.rows.get("bot-1")?.reassign_state).toBeNull();
    expect(runtime.reconfigureCalls).toHaveLength(0);
  });

  it("refuses to reassign a bot with no stored credential (fails before any teardown)", async () => {
    const { svc, bots, connections } = make();
    bots.seed({ bot_id: "bot-1", gateway_id: "gw-1", status: "running" }); // no creds
    const res = await svc.updateConfig("bot-1", { gatewayId: "gw-2" });
    expect(res.kind).toBe("do_error");
    // guarded BEFORE detach — the old socket is never torn down.
    expect(connections.calls).toHaveLength(0);
    expect(bots.rows.get("bot-1")?.gateway_id).toBe("gw-1");
  });

  it("does NOT run the saga for a same-gateway PATCH (live reconfigure only)", async () => {
    const { svc, bots, runtime, connections } = make();
    bots.seed({
      bot_id: "bot-1",
      gateway_id: "gw-1",
      status: "running",
      api_id: CREDS.apiId,
      api_hash: CREDS.apiHash,
      session_credential: CREDS.sessionCredential,
    });
    const res = await svc.updateConfig("bot-1", { gatewayId: "gw-1" });
    if (res.kind !== "ok") throw new Error(`expected ok, got ${res.kind}`);
    // gateway unchanged -> no socket churn, just a live reconfigure (prior contract).
    expect(connections.calls).toHaveLength(0);
    expect(runtime.reconfigureCalls).toEqual([{ botId: "bot-1", opts: { gatewayId: "gw-1" } }]);
  });

  it("force-restarts on a persona change (needs re-hydration)", async () => {
    const { svc, bots, runtime, dir } = make();
    bots.seed({ bot_id: "bot-1", gateway_id: "gw-1", status: "running" });
    const res = await svc.updateConfig("bot-1", { personaName: "New Name" });
    if (res.kind !== "ok") throw new Error(`expected ok, got ${res.kind}`);
    expect(res.restarted).toBe(true);
    expect(runtime.reconfigureCalls).toHaveLength(0);
    expect(runtime.startCalls[0]).toMatchObject({ botId: "bot-1", personaName: "New Name", force: true });
    // gateway not touched -> no roster read
    expect(dir.calls).toBe(0);
  });

  it("updates D1 only for a non-running bot", async () => {
    const { svc, bots, runtime } = make();
    bots.seed({ bot_id: "bot-1", gateway_id: "gw-1", status: "stopped" });
    const res = await svc.updateConfig("bot-1", { gatewayId: "gw-2" });
    if (res.kind !== "ok") throw new Error(`expected ok, got ${res.kind}`);
    expect(res.restarted).toBe(false);
    expect(runtime.reconfigureCalls).toHaveLength(0);
    expect(runtime.startCalls).toHaveLength(0);
    expect(bots.rows.get("bot-1")?.gateway_id).toBe("gw-2");
  });

  it("rejects an unknown gateway and leaves the mapping untouched", async () => {
    const { svc, bots, runtime } = make({ status: "ok", gateways: ["gw-1"] });
    bots.seed({ bot_id: "bot-1", gateway_id: "gw-1", status: "running" });
    const res = await svc.updateConfig("bot-1", { gatewayId: "gw-9" });
    expect(res).toEqual({ kind: "unknown_gateway", gatewayId: "gw-9", known: ["gw-1"] });
    expect(bots.rows.get("bot-1")?.gateway_id).toBe("gw-1");
    expect(runtime.reconfigureCalls).toHaveLength(0);
  });

  it("commits the move but returns do_error when the routing reconfigure throws (post-commit)", async () => {
    const { svc, bots, runtime } = make();
    bots.seed({
      bot_id: "bot-1",
      gateway_id: "gw-1",
      status: "running",
      api_id: CREDS.apiId,
      api_hash: CREDS.apiHash,
      session_credential: CREDS.sessionCredential,
    });
    runtime.reconfigureError = new Error("rpc down");
    const res = await svc.updateConfig("bot-1", { gatewayId: "gw-2" });
    expect(res).toEqual({ kind: "do_error", botId: "bot-1", error: "rpc down" });
    // Sockets + D1 are already on gw-2 (commit precedes the routing RPC); a re-drive
    // fixes routing. Bot NOT marked failed; saga cursor cleared by the commit.
    expect(bots.rows.get("bot-1")?.gateway_id).toBe("gw-2");
    expect(bots.rows.get("bot-1")?.status).toBe("running");
    expect(bots.rows.get("bot-1")?.reassign_state).toBeNull();
  });

  it("still returns 200 when reconfigure reports ok:false (TOCTOU)", async () => {
    const { svc, bots, runtime } = make();
    bots.seed({
      bot_id: "bot-1",
      gateway_id: "gw-1",
      status: "running",
      api_id: CREDS.apiId,
      api_hash: CREDS.apiHash,
      session_credential: CREDS.sessionCredential,
    });
    runtime.reconfigureResult = { ok: false, reason: "not running" };
    const res = await svc.updateConfig("bot-1", { gatewayId: "gw-2" });
    if (res.kind !== "ok") throw new Error(`expected ok, got ${res.kind}`);
    expect(res.reconfigured).toBe(false);
    expect(res.restarted).toBe(false);
    expect(bots.rows.get("bot-1")?.gateway_id).toBe("gw-2");
  });
});

// ---- restart -------------------------------------------------------------

describe("BotService.restart", () => {
  it("404s when the bot does not exist", async () => {
    const { svc } = make();
    expect(await svc.restart("ghost")).toEqual({ kind: "not_found", botId: "ghost" });
  });

  it("409s (not_running) for a stopped bot and never calls start()", async () => {
    const { svc, bots, runtime } = make();
    bots.seed({ bot_id: "bot-1", status: "stopped" });
    expect(await svc.restart("bot-1")).toEqual({ kind: "not_running", botId: "bot-1" });
    expect(runtime.startCalls).toHaveLength(0);
  });

  it("force-restarts a running bot with its CURRENT mapping (no body, no reconfigure)", async () => {
    const { svc, bots, runtime, dir } = make();
    bots.seed({ bot_id: "bot-1", gateway_id: "gw-2", persona_name: "Tanya", status: "running" });
    const res = await svc.restart("bot-1");
    if (res.kind !== "ok") throw new Error(`expected ok, got ${res.kind}`);
    // Uses the row's own gateway + persona, force:true; never reconfigures.
    expect(runtime.startCalls[0]).toMatchObject({
      botId: "bot-1",
      gatewayId: "gw-2",
      personaName: "Tanya",
      force: true,
    });
    expect(runtime.reconfigureCalls).toHaveLength(0);
    // Pure recycle: no roster read (gateway not changing) and status stays running.
    expect(dir.calls).toBe(0);
    expect(bots.rows.get("bot-1")?.status).toBe("running");
  });

  it("marks the row failed and returns do_error when start() throws", async () => {
    const { svc, bots, runtime } = make();
    bots.seed({ bot_id: "bot-1", status: "running" });
    runtime.startError = new Error("do down");
    expect(await svc.restart("bot-1")).toEqual({ kind: "do_error", botId: "bot-1", error: "do down" });
    expect(bots.rows.get("bot-1")?.status).toBe("failed");
  });

  it("returns start_failed and marks the row failed when start() reports ok:false", async () => {
    const { svc, bots, runtime } = make();
    bots.seed({ bot_id: "bot-1", status: "running" });
    runtime.startResult = { ok: false, reason: "boom" };
    const res = await svc.restart("bot-1");
    if (res.kind !== "start_failed") throw new Error(`expected start_failed, got ${res.kind}`);
    expect(bots.rows.get("bot-1")?.status).toBe("failed");
  });
});

// ---- reconcileStuckSagas -------------------------------------------------

/** Seed a bot mid-reassign (gw-1 -> gw-2) stuck at `state`, started `ageMs` ago. */
function seedStuck(
  bots: FakeBotsDao,
  state: BotRow["reassign_state"],
  ageMs: number,
  botId = "bot-1",
) {
  bots.seed({
    bot_id: botId,
    gateway_id: "gw-1",
    status: "running",
    api_id: CREDS.apiId,
    api_hash: CREDS.apiHash,
    session_credential: CREDS.sessionCredential,
    reassign_target_gw: "gw-2",
    reassign_state: state,
    reassign_started_at: Date.now() - ageMs,
  });
}

describe("BotService.reconcileStuckSagas", () => {
  it("ignores a saga younger than the timeout (still in flight)", async () => {
    const { svc, bots, connections } = make();
    seedStuck(bots, "detached", 10_000); // 10s old
    const res = await svc.reconcileStuckSagas(120_000);
    expect(res.swept).toBe(0);
    expect(connections.calls).toHaveLength(0);
  });

  it("resumes a 'detached' saga forward: attach target + commit + reconfigure", async () => {
    const { svc, bots, runtime, connections } = make();
    seedStuck(bots, "detached", 200_000); // older than timeout
    const res = await svc.reconcileStuckSagas(120_000);
    expect(res.swept).toBe(1);
    expect(res.results[0]).toMatchObject({ botId: "bot-1", fromState: "detached", kind: "ok" });
    // detached => NO second detach; straight to attach on the target.
    expect(connections.calls).toEqual(["connect:gw-2"]);
    expect(runtime.reconfigureCalls).toEqual([{ botId: "bot-1", opts: { gatewayId: "gw-2" } }]);
    expect(bots.rows.get("bot-1")?.gateway_id).toBe("gw-2");
    expect(bots.rows.get("bot-1")?.reassign_state).toBeNull();
  });

  it("resumes a 'requested' saga by detaching first, then attach+commit", async () => {
    const { svc, bots, connections } = make();
    seedStuck(bots, "requested", 200_000);
    const res = await svc.reconcileStuckSagas(120_000);
    expect(res.results[0].kind).toBe("ok");
    // requested => old socket still live, so detach BEFORE attach.
    expect(connections.calls).toEqual(["disconnect:gw-1", "connect:gw-2"]);
    expect(bots.rows.get("bot-1")?.gateway_id).toBe("gw-2");
  });

  it("resumes an 'attached' saga by committing only (no re-attach)", async () => {
    const { svc, bots, runtime, connections } = make();
    seedStuck(bots, "attached", 200_000);
    const res = await svc.reconcileStuckSagas(120_000);
    expect(res.results[0].kind).toBe("ok");
    // socket already live on the target => neither disconnect nor connect.
    expect(connections.calls).toHaveLength(0);
    expect(runtime.reconfigureCalls).toEqual([{ botId: "bot-1", opts: { gatewayId: "gw-2" } }]);
    expect(bots.rows.get("bot-1")?.gateway_id).toBe("gw-2");
    expect(bots.rows.get("bot-1")?.reassign_state).toBeNull();
  });

  it("clears an unrecoverable stuck saga (missing credential) leaving it on the old gateway", async () => {
    const { svc, bots, connections } = make();
    bots.seed({
      bot_id: "bot-1",
      gateway_id: "gw-1",
      status: "running",
      reassign_target_gw: "gw-2",
      reassign_state: "detached",
      reassign_started_at: Date.now() - 200_000,
    }); // no creds
    const res = await svc.reconcileStuckSagas(120_000);
    expect(res.results[0].kind).toBe("do_error");
    expect(connections.calls).toHaveLength(0);
    expect(bots.rows.get("bot-1")?.gateway_id).toBe("gw-1");
    expect(bots.rows.get("bot-1")?.reassign_state).toBeNull(); // cleared
  });

  it("sweeps multiple stuck sagas, one failure not blocking the rest", async () => {
    const { svc, bots, connections } = make();
    seedStuck(bots, "detached", 200_000, "bot-1");
    seedStuck(bots, "attached", 300_000, "bot-2");
    // bot-1's target attach fails; rollback re-connect succeeds.
    connections.connectResults = [
      { ok: false, error: "SESSION_REVOKED" }, // bot-1 attach gw-2
      { ok: true, identity: { id: "1", username: null, phone: null } }, // bot-1 rollback gw-1
    ];
    const res = await svc.reconcileStuckSagas(120_000);
    expect(res.swept).toBe(2);
    const byBot = Object.fromEntries(res.results.map((r) => [r.botId, r.kind]));
    expect(byBot["bot-1"]).toBe("connection_failed");
    expect(byBot["bot-2"]).toBe("ok");
    // bot-2 committed to gw-2; bot-1 rolled back to gw-1.
    expect(bots.rows.get("bot-2")?.gateway_id).toBe("gw-2");
    expect(bots.rows.get("bot-1")?.gateway_id).toBe("gw-1");
  });
});

// ---- reconcileConnections ------------------------------------------------

describe("BotService.reconcileConnections", () => {
  it("leaves a healthy bot alone (its socket is in the live set)", async () => {
    const { svc, bots, connections, gatewayStore } = make();
    bots.seed({
      bot_id: "bot-1",
      gateway_id: "gw-1",
      status: "running",
      api_id: CREDS.apiId,
      api_hash: CREDS.apiHash,
      session_credential: CREDS.sessionCredential,
    });
    connections.statusByGw["gw-1"] = { ok: true, connected: ["bot-1"] };
    const res = await svc.reconcileConnections();
    expect(res.results).toHaveLength(0);
    expect(connections.connectCalls).toHaveLength(0);
    // reachable + live socket => active health
    expect(gatewayStore.probeCalls).toEqual([{ gatewayId: "gw-1", health: "active" }]);
  });

  it("reconnects a running bot whose socket is silently dead", async () => {
    const { svc, bots, connections, gatewayStore } = make();
    bots.seed({
      bot_id: "bot-1",
      gateway_id: "gw-1",
      status: "running",
      api_id: CREDS.apiId,
      api_hash: CREDS.apiHash,
      session_credential: CREDS.sessionCredential,
    });
    connections.statusByGw["gw-1"] = { ok: true, connected: [] }; // dark
    const res = await svc.reconcileConnections();
    expect(res.results).toEqual([{ gatewayId: "gw-1", botId: "bot-1", kind: "reconnected" }]);
    expect(connections.connectCalls[0]).toMatchObject({
      gatewayId: "gw-1",
      botId: "bot-1",
      apiId: CREDS.apiId,
      sessionCredential: CREDS.sessionCredential,
    });
    // reachable + this bot's socket was dark (connected: []) => inactive health
    expect(gatewayStore.probeCalls).toEqual([{ gatewayId: "gw-1", health: "inactive" }]);
  });

  it("skips a whole gateway that cannot be probed (do not thrash a down container)", async () => {
    const { svc, bots, connections, gatewayStore } = make();
    bots.seed({
      bot_id: "bot-1",
      gateway_id: "gw-1",
      status: "running",
      api_id: CREDS.apiId,
      api_hash: CREDS.apiHash,
      session_credential: CREDS.sessionCredential,
    });
    connections.statusByGw["gw-1"] = { ok: false, error: "unreachable" };
    const res = await svc.reconcileConnections();
    expect(res.results).toEqual([{ gatewayId: "gw-1", kind: "gateway_unreachable", error: "unreachable" }]);
    expect(connections.connectCalls).toHaveLength(0);
    // an unreachable gateway still records a probe — that IS the degraded signal
    expect(gatewayStore.probeCalls).toEqual([{ gatewayId: "gw-1", health: "degraded" }]);
  });

  it("ignores non-running and mid-reassign bots", async () => {
    const { svc, bots, connections, gatewayStore } = make();
    bots.seed({ bot_id: "stopped-1", gateway_id: "gw-1", status: "stopped" });
    bots.seed({
      bot_id: "moving-1",
      gateway_id: "gw-1",
      status: "running",
      reassign_state: "detached",
      reassign_target_gw: "gw-2",
      api_id: CREDS.apiId,
      api_hash: CREDS.apiHash,
      session_credential: CREDS.sessionCredential,
    });
    connections.statusByGw["gw-1"] = { ok: true, connected: [] };
    const res = await svc.reconcileConnections();
    // neither is eligible => no gateway probed, no reconnect, no probe recorded
    expect(res.running).toBe(0);
    expect(connections.statusCalls).toHaveLength(0);
    expect(connections.connectCalls).toHaveLength(0);
    expect(gatewayStore.probeCalls).toHaveLength(0);
  });

  it("reports no_credential for a dark running bot missing its quad (cannot heal)", async () => {
    const { svc, bots, connections } = make();
    bots.seed({ bot_id: "bot-1", gateway_id: "gw-1", status: "running" }); // no creds
    connections.statusByGw["gw-1"] = { ok: true, connected: [] };
    const res = await svc.reconcileConnections();
    expect(res.results).toEqual([{ gatewayId: "gw-1", botId: "bot-1", kind: "no_credential" }]);
    expect(connections.connectCalls).toHaveLength(0);
  });

  it("records last_conn_error when a heal reconnect fails (feeds traffic light #4 red)", async () => {
    const { svc, bots, connections } = make();
    bots.seed({
      bot_id: "bot-1",
      gateway_id: "gw-1",
      status: "running",
      api_id: CREDS.apiId,
      api_hash: CREDS.apiHash,
      session_credential: CREDS.sessionCredential,
    });
    connections.statusByGw["gw-1"] = { ok: true, connected: [] }; // dark -> heal attempted
    connections.connectResults = [{ ok: false, error: "AUTH_KEY_DUPLICATED" }];
    const res = await svc.reconcileConnections();
    expect(res.results).toEqual([
      { gatewayId: "gw-1", botId: "bot-1", kind: "reconnect_failed", error: "AUTH_KEY_DUPLICATED" },
    ]);
    // the observed failure is now PERSISTED (was previously discarded to logs only)
    expect(bots.connErrCalls).toEqual([{ botId: "bot-1", error: "AUTH_KEY_DUPLICATED" }]);
    expect(bots.rows.get("bot-1")?.last_conn_error).toBe("AUTH_KEY_DUPLICATED");
  });

  it("clears a stale last_conn_error when the bot's socket is healthy again", async () => {
    const { svc, bots, connections } = make();
    bots.seed({
      bot_id: "bot-1",
      gateway_id: "gw-1",
      status: "running",
      api_id: CREDS.apiId,
      api_hash: CREDS.apiHash,
      session_credential: CREDS.sessionCredential,
      last_conn_error: "AUTH_KEY_DUPLICATED",
      last_conn_error_at: 1000,
    });
    connections.statusByGw["gw-1"] = { ok: true, connected: ["bot-1"] }; // live socket
    await svc.reconcileConnections();
    expect(connections.connectCalls).toHaveLength(0); // healthy: no reconnect
    expect(bots.connErrCalls).toEqual([{ botId: "bot-1", error: null }]); // stale error cleared
    expect(bots.rows.get("bot-1")?.last_conn_error).toBeNull();
  });

  it("does not write a clear for a healthy bot that had no error (no needless UPDATE)", async () => {
    const { svc, bots, connections } = make();
    bots.seed({
      bot_id: "bot-1",
      gateway_id: "gw-1",
      status: "running",
      api_id: CREDS.apiId,
      api_hash: CREDS.apiHash,
      session_credential: CREDS.sessionCredential,
    });
    connections.statusByGw["gw-1"] = { ok: true, connected: ["bot-1"] };
    await svc.reconcileConnections();
    expect(bots.connErrCalls).toHaveLength(0);
  });

  it("clears the error on a successful heal reconnect", async () => {
    const { svc, bots, connections } = make();
    bots.seed({
      bot_id: "bot-1",
      gateway_id: "gw-1",
      status: "running",
      api_id: CREDS.apiId,
      api_hash: CREDS.apiHash,
      session_credential: CREDS.sessionCredential,
      last_conn_error: "AUTH_KEY_DUPLICATED",
      last_conn_error_at: 1000,
    });
    connections.statusByGw["gw-1"] = { ok: true, connected: [] }; // dark -> heal attempted
    connections.connectResults = [{ ok: true, identity: { id: "1", username: null, phone: null } }];
    const res = await svc.reconcileConnections();
    expect(res.results).toEqual([{ gatewayId: "gw-1", botId: "bot-1", kind: "reconnected" }]);
    expect(bots.connErrCalls).toEqual([{ botId: "bot-1", error: null }]);
    expect(bots.rows.get("bot-1")?.last_conn_error).toBeNull();
  });
});
