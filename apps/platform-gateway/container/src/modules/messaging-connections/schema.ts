import { z } from "zod";

/**
 * Body of POST /connection/connect. The Postgres DSN rides the same body under the
 * shared DB_DSN_FIELD key (Option B, body transport) but is read separately in
 * the controller (dynamic key), so it is not part of this schema.
 *
 * ⚠ `sessionCredential` is a full-account StringSession — validated here, but
 * NEVER logged or echoed in a response.
 */
export const connectRequestSchema = z.object({
  botId: z.string().min(1),
  sessionCredential: z.string().min(1),
  // Per-bot MTProto creds (anti-ban). Optional: when omitted the
  // container falls back to the app-level env pair (dev/bootstrap). apiHash is a
  // secret — validated here, NEVER logged. In these arrive from the gateway
  // DO's provisioned credential triple.
  apiId: z.coerce.number().int().positive().optional(),
  apiHash: z.string().min(1).optional(),
});

export type ConnectRequest = z.infer<typeof connectRequestSchema>;

/**
 * Body of POST /connection/disconnect — tear this bot's live MTProto socket down
 * and drop it from the in-memory registry (reassignment detach). Only
 * the botId is needed: no credential (we are destroying state, not creating it).
 * Idempotent at the service layer (a bot with no live socket is a no-op).
 */
export const disconnectRequestSchema = z.object({
  botId: z.string().min(1),
});

export type DisconnectRequest = z.infer<typeof disconnectRequestSchema>;
