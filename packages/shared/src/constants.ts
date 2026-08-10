export const DEFAULT_ENV = "dev-local";
export const sharedVersion = "0.0.0";

/**
 * JSON BODY field the gateway Worker uses to forward the Supabase DSN to its
 * container on DB routes (`/inbound`, `/deliver`) — Option B, BODY transport.
 *
 * WHY THE BODY, NOT A HEADER: Cloudflare invocation logs (Workers Logs +
 * `wrangler tail`) capture request URL + method + HEADERS in plaintext, so a DSN
 * carried in a header leaked the Supabase password into logs on every request.
 * Request BODIES are never captured by observability, so the secret rides here
 * instead. Only the two DB routes inject it; non-DB routes (`/health`, `/outbox`)
 * never receive it. The container reads it, (re)builds its pg.Pool (a rotated
 * secret is still picked up without a redeploy), and never logs it. The
 * double-underscore marks it as an internal transport field, distinct from the
 * domain message payload. Single source of truth so the two builds can't drift.
 */
export const DB_DSN_FIELD = "__dbDsn";

export const workerPackage = {
  name: "@tutorbot/platform-gateway-worker",
} as const;
