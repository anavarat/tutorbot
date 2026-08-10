export type CorrelationContext = {
  readonly request_id: string;
  readonly cf_ray?: string;
};

/**
 * Build a correlation context for one inbound request.
 *
 * Honours an inbound `x-request-id` (so an upstream caller can propagate a single
 * id across hops — fm -> pgw worker -> container) and otherwise mints a fresh
 * UUID. Also captures Cloudflare's edge `cf-ray` when present.
 *
 * Works on both the Workers isolate and the Node container: both expose a global
 * `Request` and `crypto.randomUUID`. The bot-fleet DO loop has no inbound Request
 * (it is self-driven), so it builds a context from a minted runId instead of
 * calling this.
 */
export function createCorrelationContext(
  request: Request,
  generateRequestId: () => string = () => crypto.randomUUID(),
): CorrelationContext {
  const inboundRequestId = request.headers.get("x-request-id")?.trim();
  const cfRay = request.headers.get("cf-ray")?.trim();

  const requestId =
    inboundRequestId && inboundRequestId.length > 0 ? inboundRequestId : generateRequestId();

  if (cfRay && cfRay.length > 0) {
    return { request_id: requestId, cf_ray: cfRay };
  }

  return { request_id: requestId };
}

/** Flatten a correlation context into log-friendly string fields. */
export function correlationDetails(correlation: CorrelationContext): Record<string, string> {
  if (correlation.cf_ray === undefined) {
    return { request_id: correlation.request_id };
  }

  return { request_id: correlation.request_id, cf_ray: correlation.cf_ray };
}
