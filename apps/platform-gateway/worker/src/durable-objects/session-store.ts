import { DB_DSN_FIELD } from "@tutorbot/shared";

/**
 * session persistence for the GatewayContainer DO.
 *
 * The gateway DO OUTLIVES its ephemeral container: `ctx.storage` survives DO
 * hibernation/eviction AND container restarts (deploys, host reboots, OOM), while
 * the container's in-memory `connectionRegistry` (the live MTProto sockets) does
 * NOT. So on every container (re)start the DO must rebuild those sockets from a
 * durable copy of each bot's credential — with NO re-auth/OTP (the session was
 * minted offline). This module is the small, pure, storage-facing core of that:
 * write the credential on connect, list it back on boot. The DO wires it (I/O +
 * lifecycle); these helpers stay unit-testable against a fake storage.
 *
 * Stored per bot = ONLY `{ apiId, sessionCredential }`. Deliberately NOT the
 * `api_hash`: teleproto's `TelegramClient` ctor rejects an empty hash, but
 * `connect()` (a reconnect of a pre-minted session) never READS it — `api_hash`
 * is exercised only on the login path (`auth.js`: sendCode/signIn), which the
 * container never runs. So the real app-secret hash need never reach the
 * ephemeral container or durable DO storage; a placeholder satisfies the ctor.
 * This shrinks the blast radius of a storage/container compromise from "the whole
 * app (every bot on that api_id)" to "this one account" (refined).
 * The DSN is likewise NOT stored — it rotates, so the DO re-resolves it fresh
 * from the Secrets Store at recovery time.
 */

/** The credential the DO persists per bot (the minimal set the container needs). */
export interface StoredSession {
  apiId: number;
  sessionCredential: string;
}

/** A stored session plus the botId recovered from its storage key. */
export interface RecoverableSession extends StoredSession {
  botId: string;
}

/**
 * The subset of `DurableObjectStorage` these helpers touch. Narrowing it to an
 * interface keeps the helpers testable with a plain Map-backed fake (no workers
 * runtime) and documents exactly what depends on.
 */
export interface SessionStorage {
  put(key: string, value: StoredSession): Promise<void>;
  list(options: { prefix: string }): Promise<Map<string, StoredSession>>;
  delete(key: string): Promise<boolean>;
}

/** Key namespace so session records never collide with any other DO storage keys. */
export const SESSION_PREFIX = "session:";

/**
 * Non-empty stand-in for `api_hash` sent to the container. See the module note:
 * `connect()` never reads it, but the teleproto ctor throws on an empty hash.
 */
export const PLACEHOLDER_API_HASH = "unused";

export function sessionKey(botId: string): string {
  return `${SESSION_PREFIX}${botId}`;
}

/**
 * Validate + narrow an incoming `/connection/connect` body to the persistable
 * credential. Returns null when the body lacks the fields (the DO then just
 * forwards without persisting — the container's own schema will reject it).
 */
export function parseSession(body: unknown): RecoverableSession | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (typeof b.botId !== "string" || !b.botId) return null;
  if (typeof b.apiId !== "number" || !b.apiId) return null;
  if (typeof b.sessionCredential !== "string" || !b.sessionCredential) return null;
  return { botId: b.botId, apiId: b.apiId, sessionCredential: b.sessionCredential };
}

export async function persistSession(storage: SessionStorage, s: RecoverableSession): Promise<void> {
  await storage.put(sessionKey(s.botId), { apiId: s.apiId, sessionCredential: s.sessionCredential });
}

export async function listSessions(storage: SessionStorage): Promise<RecoverableSession[]> {
  const map = await storage.list({ prefix: SESSION_PREFIX });
  const out: RecoverableSession[] = [];
  for (const [key, val] of map) {
    out.push({ botId: key.slice(SESSION_PREFIX.length), apiId: val.apiId, sessionCredential: val.sessionCredential });
  }
  return out;
}

export async function deleteSession(storage: SessionStorage, botId: string): Promise<boolean> {
  return storage.delete(sessionKey(botId));
}

/**
 * The `/connection/connect` body the DO sends to the container — used both when
 * forwarding a fresh connect and when replaying on boot recovery. Injects the
 * placeholder `api_hash` (real hash never reaches the container) and the freshly
 * resolved DSN under the body-transport field the container caches.
 */
export function buildConnectBody(s: RecoverableSession, dsn: string): Record<string, unknown> {
  return {
    botId: s.botId,
    apiId: s.apiId,
    apiHash: PLACEHOLDER_API_HASH,
    sessionCredential: s.sessionCredential,
    [DB_DSN_FIELD]: dsn,
  };
}
