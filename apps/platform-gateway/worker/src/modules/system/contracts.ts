import {
  CONTAINER_REQUEST_FAILED,
  resolveRuntimeHealth,
  type RuntimeErrorResponse,
  type RuntimeHealthResponse,
} from "@tutorbot/shared";

export interface WorkerBindings {
  APP_ENV?: string;
  APP_VERSION?: string;
  GATEWAY_CONTAINER?: unknown;

  /**
   * Service binding to the FleetManager control-plane Worker. This is an
   * INTERNAL Worker-to-Worker dispatch, so it bypasses Access + CORS (no service
   * token required). Two uses:
   *   - GET /bot-gateway    -> resolve a botId to its home gatewayId (FleetManager
   *                            D1 owns the bot->gateway mapping).
   *   - the active gateway ROSTER (see roster.ts) -> FleetManager D1 owns which
   *                            gateways exist; this Worker fetches + caches it and
   *                            materialises a container per id lazily. There is no
   *                            Cloudflare API that lists running containers, so the
   *                            FleetManager roster is the only authority.
   */
  FLEET_MANAGER?: { fetch(input: Request): Promise<Response> };

  /**
   * Postgres PASSWORD, sourced from the account SECRETS STORE (not a per-Worker
   * secret). Secrets Store binding: `.get()` is async, returns plaintext at
   * runtime. ONLY the password is secret — the Worker assembles the full DSN
   * from this + the non-secret DB_* vars below (see modules/db/dsn.ts),
   * caches it in-isolate, and forwards it to the container per-request in the DB
   * routes' request BODY (Option B, body transport — see DB_DSN_FIELD; a header
   * would leak into invocation logs). The stored value must be the RAW password
   * (the code URL-encodes it). Rotate = update the Secrets Store secret; no redeploy.
   */
  DB_PASSWORD?: { get(): Promise<string> };

  /**
   * Non-secret Postgres connection parts (plain Worker vars). Assembled with the
   * DB_PASSWORD secret into the DSN in modules/db/dsn.ts. Defaults applied
   * there: DB_PORT -> "5432", DB_NAME -> "postgres".
   */
  DB_USER?: string;
  DB_HOST?: string;
  DB_PORT?: string;
  DB_NAME?: string;

  /**
   * DEV / BOOTSTRAP FALLBACK MTProto credentials. Real creds are PER-BOT (decision
   * 5, anti-ban): they ride the `/connection/connect` body (part of the provisioned
   * credential triple) and the container prefers them. This single optional pair
   * only backstops local/dev connects where no per-bot creds are supplied. Set as
   * per-Worker secrets (`wrangler secret put TELEGRAM_API_ID` / `TELEGRAM_API_HASH`),
   * which arrive as plain SYNC string bindings (buildContainerEnv runs in the DO
   * constructor). Forwarded into the container env; the container reads them from
   * process.env only when the connect body omits them. NEVER logged.
   */
  TELEGRAM_API_ID?: string;
  TELEGRAM_API_HASH?: string;
}

export type HealthResponse = RuntimeHealthResponse<"worker">;
export type ErrorResponse = RuntimeErrorResponse<typeof CONTAINER_REQUEST_FAILED>;

export function resolveHealth(bindings?: WorkerBindings): HealthResponse {
  return resolveRuntimeHealth("worker", bindings);
}
