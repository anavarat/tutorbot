import { getContainer } from "@cloudflare/containers";
import { CONTAINER_REQUEST_FAILED, GATEWAY_UNKNOWN } from "@tutorbot/shared";

import type { WorkerBindings } from "../system/contracts.js";
import { getDsn } from "../db/dsn.js";
import { getRoster } from "./roster.js";

/**
 * Whether `gatewayId` is in the active roster. The roster (set of gateway
 * container names this Worker may route to) is OWNED by FleetManager (D1) and
 * fetched via the FLEET_MANAGER service binding, cached in-isolate (see
 * roster.ts). Async because a cache miss calls FleetManager. Each id is used
 * verbatim as the GatewayContainer DO instance name:
 * getContainer(GATEWAY_CONTAINER, id) boots / addresses exactly one container.
 */
export async function isKnownGateway(env: WorkerBindings, gatewayId: string): Promise<boolean> {
  return (await getRoster(env)).has(gatewayId);
}

type GatewayContainerStub = ReturnType<typeof getContainer>;

export type GatewayResolution =
  | { ok: true; container: GatewayContainerStub }
  | { ok: false; response: Response };

function gatewayErrorResponse(code: string, message: string, status: number): Response {
  return Response.json({ ok: false, component: "worker", error: { code, message } }, { status });
}

/**
 * Resolve a gatewayId to its container stub, routing purely by name. The set of
 * valid ids is the active roster from FleetManager (see roster.ts). Unknown ids
 * are rejected (404 GATEWAY_UNKNOWN) so a typo / stale mapping can never silently
 * address a new name and boot a rogue container against max_instances. Async
 * because the roster lookup may hit FleetManager on a cache miss.
 */
export async function resolveGatewayContainer(
  env: WorkerBindings,
  gatewayId: string,
): Promise<GatewayResolution> {
  if (!env.GATEWAY_CONTAINER) {
    return {
      ok: false,
      response: gatewayErrorResponse(
        CONTAINER_REQUEST_FAILED,
        "GATEWAY_CONTAINER binding is not configured",
        500,
      ),
    };
  }

  const roster = await getRoster(env);
  if (!gatewayId || !roster.has(gatewayId)) {
    const known = [...roster].join(", ") || "(none)";
    return {
      ok: false,
      response: gatewayErrorResponse(
        GATEWAY_UNKNOWN,
        `Unknown gatewayId '${gatewayId}'. Known gateways: ${known}`,
        404,
      ),
    };
  }

  return { ok: true, container: getContainer(env.GATEWAY_CONTAINER as never, gatewayId) };
}

/**
 * Stop a gateway's container instance by name, BYPASSING the roster check. The
 * caller (FleetManager reap) may have ALREADY removed this gateway from the
 * roster, but the container it lazily materialised keeps running until its
 * sleepAfter idle window (5h) — so we stop it explicitly to halt running/billing
 * immediately. Idempotent: stopping a stopped / never-started instance is a
 * no-op. Uses the DO's shutdown() (-> this.stop(), SIGTERM); the DO persists and
 * can be re-materialised by a future getContainer() if the gateway is
 * re-provisioned.
 */
export async function stopGatewayContainer(env: WorkerBindings, gatewayId: string): Promise<void> {
  if (!env.GATEWAY_CONTAINER) {
    throw new Error("GATEWAY_CONTAINER binding is not configured");
  }
  if (!gatewayId) {
    throw new Error("missing gatewayId");
  }
  const container = getContainer(env.GATEWAY_CONTAINER as never, gatewayId) as unknown as {
    shutdown(): Promise<void>;
  };
  await container.shutdown();
}

/**
 * Route an internal request to the named gateway container. Route handlers call
 * this so the container always sees a clean path (e.g. `/deliver`) regardless of
 * the public route the Worker exposed.
 *
 * This is a PURE forwarder — it does NOT attach the Postgres DSN. The DSN is a
 * secret and Cloudflare invocation logs capture request URL + method + HEADERS,
 * so it must never ride a header/URL. DB routes inject it into the request BODY
 * instead (see resolveDbDsn + DB_DSN_FIELD); non-DB routes never carry it.
 */
export async function forwardToGateway(
  env: WorkerBindings,
  gatewayId: string,
  internalPath: string,
  init?: RequestInit,
): Promise<Response> {
  const resolution = await resolveGatewayContainer(env, gatewayId);
  if (!resolution.ok) {
    return resolution.response;
  }

  return resolution.container.fetch(new Request(`http://container${internalPath}`, init));
}

/**
 * Resolve the Postgres DSN for injection into a DB-route request BODY (Option B,
 * body transport — see DB_DSN_FIELD). Best-effort: on a Secrets Store miss it
 * returns an empty dsn plus the error string, and the caller forwards anyway (the
 * container then 500s on the DB op, exactly as a missing value did before). Kept
 * here so the DB-route handlers (/outbound, /connection/connect) share one resolver.
 */
export async function resolveDbDsn(
  env: WorkerBindings,
): Promise<{ dsn: string; error?: string }> {
  try {
    return { dsn: await getDsn(env) };
  } catch (err) {
    return { dsn: "", error: err instanceof Error ? err.message : String(err) };
  }
}
