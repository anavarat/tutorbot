import type { BotFleetEnv } from "../../types";

/**
 * SEND-to-gateway (step 7). After the bot persists its reply to sent_message it
 * notifies the PG Worker, which routes by gatewayId to the container that owns
 * the conversation and delivers the reply (temp UI now, Telegram client later).
 *
 * Transport, in priority order (mirrors fleet-manager's HttpGatewayDirectory,
 * apps/fleet-manager/src/platform/gateway/gateway-directory.ts):
 *  1. env.GATEWAY service binding (PREFERRED). A Worker->Worker call reaches PG
 *     directly, bypassing Cloudflare Access + the public edge — REQUIRED for an
 *     Access-gated PG, because a Worker subrequest to an Access-gated
 *     *.workers.dev host is intercepted at the edge and never reaches PG.
 *  2. env.GATEWAY_BASE_URL + optional CF-Access service-token headers (fallback
 *     for a non-binding / cross-account setup).
 *
 * Design rules:
 *  - NEVER throws: a delivery failure must not break the jittered poll cadence.
 *    The durable record already lives in sent_message; this is best-effort
 *    notification. The outcome is returned for the loop's structured log line.
 *  - NO-OP ("skip") when gatewayId is unset, or when NEITHER transport is
 *    configured. This lets the reply loop run before the gateway is wired,
 *    mirroring the AI_GATEWAY_ID "unset for now" pattern.
 */
export type DeliverStatus = "sent" | "skip" | "err";
export type DeliverTransport = "binding" | "url";

export interface DeliverResult {
  status: DeliverStatus;
  /** Which transport carried the call (omitted on "skip"); logged by the loop. */
  transport?: DeliverTransport;
  httpStatus?: number;
  /**
   * The channel's message id the gateway assigned + stamped in Supabase on a
   * successful delivery (informational; the durable "delivered" truth is the
   * stamped row itself, which the retry track polls). Absent on skip/err.
   */
  channelMessageId?: string;
  err?: string;
}

export async function deliverReplyToGateway(
  env: BotFleetEnv,
  gatewayId: string | null,
  botId: string,
  // null on a RETRY re-drive: the outbound row does not store the inbound id it
  // answered (it is only cosmetic for the temp UI); the stamp keys on the reply's
  // idempotencyKey, so a null inReplyToId never affects delivery/dedup.
  inReplyToId: number | null,
  content: string,
  idempotencyKey: string,
): Promise<DeliverResult> {
  if (!gatewayId) {
    return { status: "skip" };
  }
  // `idempotencyKey` is the turn's reply key (`reply:{channel}:{chatId}:{msgId}`) —
  // the same key recordSentMessage deduped on. It rides the payload so the
  // gateway can drop a re-driven/retried delivery (e.g. after a fiber recovery). NOTE:
  // gateway-side outbound dedup is NOT yet implemented (parked), so today the
  // key is carried but not acted on downstream; sending it now makes that fix a
  // gateway-only change with no bot-fleet churn.
  const body = JSON.stringify({ gatewayId, botId, content, inReplyToId, idempotencyKey });
  const headers: Record<string, string> = { "content-type": "application/json" };

  // 1. PREFERRED: internal service binding (no Access, no public edge). The host
  //    is irrelevant for a binding — PG's router matches on path.
  const gw = env.GATEWAY;
  if (gw) {
    return send("binding", () =>
      gw.fetch("https://gateway.internal/outbound", { method: "POST", headers, body }),
    );
  }

  // 2. FALLBACK: public base URL + optional Access service-token headers.
  const base = (env.GATEWAY_BASE_URL ?? "").replace(/\/+$/, "");
  if (!base) {
    return { status: "skip" };
  }
  if (env.CF_ACCESS_CLIENT_ID && env.CF_ACCESS_CLIENT_SECRET) {
    headers["CF-Access-Client-Id"] = env.CF_ACCESS_CLIENT_ID;
    headers["CF-Access-Client-Secret"] = env.CF_ACCESS_CLIENT_SECRET;
  }
  return send("url", () =>
    fetch(`${base}/outbound`, { method: "POST", headers, body }),
  );
}

/**
 * Shared response handling for both transports. Never throws (see design rules
 * above); maps the Response to a DeliverResult and tags the transport used.
 */
async function send(
  transport: DeliverTransport,
  doFetch: () => Promise<Response>,
): Promise<DeliverResult> {
  try {
    const res = await doFetch();
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return {
        status: "err",
        transport,
        httpStatus: res.status,
        err: text.slice(0, 200) || `HTTP ${res.status}`,
      };
    }
    // Parse the gateway's stamped channel id (best-effort; body may be absent).
    const data = (await res.json().catch(() => null)) as { channelMessageId?: unknown } | null;
    const channelMessageId =
      typeof data?.channelMessageId === "string" ? data.channelMessageId : undefined;
    return {
      status: "sent",
      transport,
      httpStatus: res.status,
      ...(channelMessageId ? { channelMessageId } : {}),
    };
  } catch (e) {
    return { status: "err", transport, err: e instanceof Error ? e.message : String(e) };
  }
}
