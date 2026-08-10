import type { Context } from "hono";
import type { AppEnv } from "../types";

/**
 * The status codes this worker actually returns. All are "contentful" codes, so
 * a value of this type is always assignable to Hono's `c.json(_, status)`
 * parameter — no need to import Hono's internal ContentfulStatusCode.
 */
export type HttpStatus = 200 | 400 | 404 | 405 | 409 | 500 | 502;

/**
 * Uniform error envelope: `{ ok: false, error, ...extra }`. Mirrors the exact
 * earlier error shapes (e.g. `{ ok:false, error:"not found", botId }`).
 */
export function fail(
  c: Context<AppEnv>,
  status: HttpStatus,
  error: string,
  extra?: Record<string, unknown>,
) {
  return c.json({ ok: false, error, ...extra }, status);
}
