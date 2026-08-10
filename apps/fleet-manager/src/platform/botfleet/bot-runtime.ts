import type {
  BotStats,
  ReconfigureOpts,
  ReconfigureResult,
  StartOpts,
  StartResult,
  StopResult,
} from "@tutorbot/shared/rpc";
import type { FleetEnv } from "../../types";

/**
 * Abstraction over "talk to a bot's runtime". The service depends on this
 * interface (trivially faked in tests) rather than the transport underneath.
 */
export interface BotRuntime {
  start(botId: string, opts: Omit<StartOpts, "botId">): Promise<StartResult>;
  reconfigure(botId: string, opts: ReconfigureOpts): Promise<ReconfigureResult>;
  stop(botId: string): Promise<StopResult>;
  stats(botId: string): Promise<BotStats>;
}

/** Pull a human message out of bot-fleet's `{ ok:false, error }` envelope. */
function extractError(body: { error?: unknown } | null): string | null {
  if (body && typeof body.error === "string") return body.error;
  return null;
}

/**
 * Real implementation: drives bot lifecycle over the BOT_FLEET service binding
 * (HTTP), the SAME transport fleet-manager uses for the gateway and the persona
 * catalog. bot-fleet's control routes (POST /bots/:id/start etc.) resolve the
 * per-bot DO by name and invoke its native method — so fleet-manager no longer
 * holds a cross-script Durable Object namespace at all.
 *
 * Failure model mirrors the old DO RPC so BotService is unchanged: a BUSINESS
 * outcome (e.g. start ok:false, reconfigure "not running") comes back as a 200 and
 * is returned as-is; an INFRA failure (binding absent, non-2xx, unreachable) THROWS
 * so the service's existing try/catch maps it to `do_error`.
 */
export class HttpBotRuntime implements BotRuntime {
  constructor(private readonly bf: FleetEnv["BOT_FLEET"]) {}

  private async call<T>(path: string, init: RequestInit): Promise<T> {
    if (!this.bf) throw new Error("BOT_FLEET service binding not configured");
    // Host is irrelevant over a service binding (never hits DNS); bot-fleet routes
    // on the path. The binding dispatch bypasses Access + the public edge.
    const res = await this.bf.fetch(new Request(`https://bot-fleet${path}`, init));
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
      throw new Error(extractError(body) ?? `bot-fleet ${path} -> HTTP ${res.status}`);
    }
    return (await res.json()) as T;
  }

  private post<T>(path: string, body?: unknown): Promise<T> {
    return this.call<T>(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
  }

  start(botId: string, opts: Omit<StartOpts, "botId">): Promise<StartResult> {
    return this.post<StartResult>(`/bots/${encodeURIComponent(botId)}/start`, opts);
  }

  reconfigure(botId: string, opts: ReconfigureOpts): Promise<ReconfigureResult> {
    return this.post<ReconfigureResult>(`/bots/${encodeURIComponent(botId)}/reconfigure`, opts);
  }

  stop(botId: string): Promise<StopResult> {
    return this.post<StopResult>(`/bots/${encodeURIComponent(botId)}/stop`);
  }

  stats(botId: string): Promise<BotStats> {
    return this.call<BotStats>(`/bots/${encodeURIComponent(botId)}/stats`, { method: "GET" });
  }
}
