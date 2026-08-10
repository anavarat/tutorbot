import { Container } from "@cloudflare/containers";
import { DB_DSN_FIELD } from "@tutorbot/shared";
import { createStageLogger } from "@tutorbot/shared/observability";

import type { WorkerBindings } from "../modules/system/contracts.js";
import { getDsn } from "../modules/db/dsn.js";
import {
  buildConnectBody,
  deleteSession,
  listSessions,
  parseSession,
  persistSession,
  type RecoverableSession,
  type SessionStorage,
} from "./session-store.js";

/**
 * DO-storage key holding THIS gateway's own id (e.g. "gw-1"). onStart has no
 * request/env with the gateway id in scope, but it needs it to pull the FM
 * recovery roster. Every /connection/connect body (provision AND
 * reassign-attach) carries `gatewayId`, so the DO learns + persists it on the
 * write path and reads it back on the next cold start. Non-session namespace so
 * it never shows up in listSessions()'s `session:` scan.
 */
const GATEWAY_ID_KEY = "meta:gatewayId";

/**
 * Build the container's runtime env from the Worker's bindings.
 *
 * NOTE: the Postgres DSN is deliberately NOT here. The DSN flows per-request in
 * the DB routes' request BODY (Option B, body transport; see DB_DSN_FIELD),
 * resolved from the account Secrets Store in modules/db/dsn.ts — injecting it as
 * a container env var froze an empty value whenever the container booted before
 * the secret existed.
 *
 * The TELEGRAM_* creds ARE passed here (unlike the DSN) as a DEV/BOOTSTRAP
 * FALLBACK only — real creds are per-bot and ride the /connection/connect body.
 * They are static (set once before first boot) so the "env froze
 * empty" DSN hazard does not apply. Omitted when unset (never injected as ""), so
 * the container's resolveCreds() reports "not provided" instead of a blank hash.
 */
function buildContainerEnv(env: WorkerBindings): Record<string, string> {
  const vars: Record<string, string> = {};
  // Dev/bootstrap fallback MTProto creds (see WorkerBindings; real creds are
  // per-bot in the connect body). Omit when unset so the container never sees an
  // empty hash. NEVER logged.
  if (env.TELEGRAM_API_ID) vars.TELEGRAM_API_ID = env.TELEGRAM_API_ID;
  if (env.TELEGRAM_API_HASH) vars.TELEGRAM_API_HASH = env.TELEGRAM_API_HASH;
  return vars;
}

export class GatewayContainer extends Container<WorkerBindings> {
  defaultPort = 8080;
  // Keep the container warm: its whole value is the set of LIVE MTProto sockets it
  // holds in memory. A short sleepAfter would hibernate it and drop every socket,
  // forcing a full cold-start recovery (re-connect every bot) on the next request.
  // A long window keeps the sockets up between bursts of activity; a true idle
  // gateway still eventually sleeps, and onStart rebuilds it from the roster.
  sleepAfter = "300m";
  pingEndpoint = "localhost/ready";

  // Captured for onStart (recovery), which has no request/env in scope. The base
  // Container uses this.ctx.storage internally but does not re-expose `ctx` on the
  // public type, so we hold our own typed handles from the constructor args.
  private readonly workerEnv: WorkerBindings;
  private readonly doCtx: ConstructorParameters<typeof Container>[0];

  constructor(ctx: ConstructorParameters<typeof Container>[0], env: WorkerBindings) {
    super(ctx, env);
    this.workerEnv = env;
    this.doCtx = ctx;
    // Inject the non-secret container config from the Worker's bindings.
    this.envVars = buildContainerEnv(env);
  }

  private get sessions(): SessionStorage {
    return this.doCtx.storage as unknown as SessionStorage;
  }

  /**
   * write half. The base Container's fetch proxies straight to the container;
   * we wrap ONLY `/connection/connect` so that before the socket is built the DO
   * durably records the bot's credential in its OWN storage (which outlives the
   * container). Two transforms on the way through:
   *   - persist `{apiId, sessionCredential}` (never the api_hash — see
   *     session-store) so a later cold-start can rebuild without FleetManager,
   *   - swap the real api_hash for the placeholder so the app-secret never
   *     reaches the ephemeral container.
   * All other paths pass through untouched. A body that isn't a valid connect is
   * forwarded as-is (the container's schema will reject it).
   */
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/connection/connect") {
      const body = await request.clone().json().catch(() => null);
      const session = parseSession(body);
      if (session) {
        await persistSession(this.sessions, session);
        // Learn + persist our own gateway id from the connect body so a later
        // cold-start onStart() can pull this gateway's recovery roster from FM.
        // Every connect (provision + reassign-attach) carries it.
        const gatewayId = (body as Record<string, unknown>).gatewayId;
        if (typeof gatewayId === "string" && gatewayId) {
          await this.doCtx.storage.put(GATEWAY_ID_KEY, gatewayId);
        }
        const dsn =
          body && typeof (body as Record<string, unknown>)[DB_DSN_FIELD] === "string"
            ? ((body as Record<string, unknown>)[DB_DSN_FIELD] as string)
            : "";
        return super.fetch(
          new Request(url.toString(), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(buildConnectBody(session, dsn)),
          }),
        );
      }
    }

    // Disconnect (reassignment DETACH): the mirror of connect's write
    // half. BEFORE tearing the live socket down in the container, delete this bot's
    // credential from the DO's OWN storage — otherwise the next cold-start onStart()
    // (which replays every stored session) would resurrect a socket for a bot that
    // has moved to another gateway, giving two live sockets on one account. If the
    // body lacks a botId it falls through untouched (the container 400s).
    if (request.method === "POST" && url.pathname === "/connection/disconnect") {
      const body = (await request.clone().json().catch(() => null)) as { botId?: unknown } | null;
      if (body && typeof body.botId === "string" && body.botId) {
        await deleteSession(this.sessions, body.botId);
      }
    }

    return super.fetch(request);
  }

  /**
   * read half — cold-start recovery. `onStart` fires whenever the base class
   * (re)starts the container: a deploy, host reboot, OOM, or a true-idle sleep all
   * wipe the container's in-memory `connectionRegistry` (the live MTProto sockets),
   * while this DO's `ctx.storage` survives. So we replay a `/connection/connect`
   * for every bot we should hold a socket for — no re-auth, no OTP (the session was
   * minted offline). The DSN rotates, so it is re-resolved fresh here, not stored.
   * Best-effort per bot: one failure must not block the others.
   *
   * Recovery source (Pull model): FM D1 is AUTHORITATIVE — we pull this
   * gateway's roster from FM and, as a side effect, refresh the DO warm-cache so it
   * converges to truth (a bot reassigned AWAY while we were down is absent from the
   * roster → we don't resurrect a duplicate socket; a bot added while down is
   * present → we pick it up). If FM is unreachable we fall back to the DO-storage
   * cache (last-known-good) so a control-plane blip can't leave the fleet dark.
   */
  override async onStart(): Promise<void> {
    const log = createStageLogger({ context: { svc: "gw-worker" } });
    const gatewayId = await this.doCtx.storage.get<string>(GATEWAY_ID_KEY);

    const fromFm = gatewayId ? await this.pullRoster(gatewayId, log) : null;
    const sessions = fromFm ?? (await listSessions(this.sessions));
    const source = fromFm ? "fleet-manager" : "do-cache";

    if (sessions.length === 0) {
      log.info("connection.recover", "container started; no sessions to recover", { count: 0, source, gatewayId });
      return;
    }

    let dsn = "";
    try {
      dsn = await getDsn(this.workerEnv);
    } catch (e) {
      // Inbound persistence will fail-and-swallow without a DSN, but the socket
      // (and outbound) still come up — recover anyway, surface the miss.
      log.warn("connection.recover", "could not resolve Postgres DSN for recovery; recovering without it", {
        error: e instanceof Error ? e.message : String(e),
      });
    }

    log.info("connection.recover", "recovering sessions after container start", {
      count: sessions.length,
      source,
    });
    for (const session of sessions) {
      try {
        // When the roster came from FM, converge the DO warm-cache to it so the
        // fallback path stays fresh for the next FM-down restart.
        if (fromFm) await persistSession(this.sessions, session);
        const res = await this.containerFetch(
          new Request("http://container/connection/connect", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(buildConnectBody(session, dsn)),
          }),
        );
        log
          .child({ botId: session.botId })
          .info("connection.recover", "re-injected session into container", { status: res.status });
      } catch (e) {
        log
          .child({ botId: session.botId })
          .error("connection.recover", "session recovery failed", {
            error: e instanceof Error ? e.message : String(e),
          });
      }
    }
  }

  /**
   * Pull this gateway's cold-start recovery roster from FleetManager
   * (the authoritative source). Returns the recoverable sessions on success, or
   * null on ANY failure (binding absent, non-2xx, malformed body) so the caller
   * falls back to the DO-storage warm-cache. Never throws — recovery is
   * best-effort and must not wedge container start. NEVER logs the credentials.
   */
  private async pullRoster(
    gatewayId: string,
    log: ReturnType<typeof createStageLogger>,
  ): Promise<RecoverableSession[] | null> {
    const fm = this.workerEnv.FLEET_MANAGER;
    if (!fm) return null;
    try {
      // Host is irrelevant over a service binding (no DNS); FM routes on path.
      const res = await fm.fetch(
        new Request(`https://fleet-manager/gateways/${encodeURIComponent(gatewayId)}/roster`, { method: "GET" }),
      );
      if (!res.ok) throw new Error(`FM GET /gateways/${gatewayId}/roster -> HTTP ${res.status}`);
      const body = (await res.json()) as {
        bots?: Array<{ botId?: unknown; apiId?: unknown; sessionCredential?: unknown }>;
      };
      const sessions: RecoverableSession[] = [];
      for (const b of body.bots ?? []) {
        if (typeof b.botId !== "string" || !b.botId) continue;
        if (typeof b.apiId !== "number" || !b.apiId) continue;
        if (typeof b.sessionCredential !== "string" || !b.sessionCredential) continue;
        sessions.push({ botId: b.botId, apiId: b.apiId, sessionCredential: b.sessionCredential });
      }
      return sessions;
    } catch (e) {
      log.warn("connection.recover", "FM roster pull failed; falling back to DO-storage cache", {
        gatewayId,
        error: e instanceof Error ? e.message : String(e),
      });
      return null;
    }
  }

  /**
   * Stop this gateway's running container instance NOW (SIGTERM via the base
   * Container's this.stop()), instead of waiting out sleepAfter. Called by the
   * Worker over RPC when FleetManager reaps this gateway. Idempotent. NB: this
   * does NOT clear the DO's session storage — a reaped gateway may be
   * re-materialised, and boot recovery should rebuild it. Deprovision-time
   * session cleanup (on bot delete / gateway reassignment) is a separate concern.
   */
  async shutdown(): Promise<void> {
    await this.stop();
  }
}
