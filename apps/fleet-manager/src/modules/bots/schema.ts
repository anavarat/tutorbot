import { z } from "zod";

/**
 * POST /bots request body, validated at the boundary. Unknown fields are
 * stripped. Tighter than the earlier build (which cast the JSON unchecked): a malformed
 * body now yields a clean 400 instead of a downstream crash / silent coercion.
 *
 * `gatewayId` — the gateway/container this bot attaches to, e.g. "gw-1" — is
 * REQUIRED: bot -> gateway is many-to-one and a bot cannot run without one. It
 * is a first-class field (persisted to the `bots.gateway_id` column and threaded
 * to the DO), NOT an open config blob.
 */
export const provisionSchema = z.object({
  botId: z.string().optional(),
  gatewayId: z.string().min(1),
  /**
   * Optional persona to give this bot's replies (display name, e.g.
   * "Tanya Alexander"), forwarded to the DO's start() and resolved against the
   * Postgres `persona` catalog there. Absent => bot runs on the default
   * (fallback) prompt. Only the name is threaded; the persona object is hydrated
   * DO-side.
   */
  personaName: z.string().min(1).optional(),
  runMinutes: z.number().positive().optional(),
  force: z.boolean().optional(),

  /**
   * Per-bot Telegram credential quad (real MTProto). REQUIRED: every bot
   * now maps to one real account, so provisioning without creds is meaningless
   * (the sim seams are gone). The operator mints the StringSession OFFLINE via the
   * local auth-ui, then supplies all four here.
   *   - apiId / apiHash: per-bot my.telegram.org app creds (anti-ban).
   *     apiId is coerced (form inputs arrive as strings).
   *   - phone: the account number — persisted as operator-facing metadata; NOT
   *     forwarded to the gateway (the session already encodes the account).
   *   - sessionCredential: the StringSession = FULL ACCOUNT ACCESS. Forwarded to
   *     the gateway's /connection/connect; stored as FM's master copy. ⚠ secret.
   */
  apiId: z.coerce.number().int().positive(),
  apiHash: z.string().min(1),
  phone: z.string().min(1),
  sessionCredential: z.string().min(1),
});

export type ProvisionInput = z.infer<typeof provisionSchema>;

/**
 * PATCH /bots/:id request body — update a bot's MAPPING (which gateway it attaches
 * to and/or its persona) AFTER provisioning. Purely DECLARATIVE: it describes the
 * desired mapping; the service picks the cheapest convergence path (gateway-only
 * change on a running bot = LIVE reconfigure; a persona change = force-restart,
 * since persona needs re-hydration). `gatewayId`/`personaName` are optional but at
 * least one must be present (an empty patch is a 400, not a no-op). Omit a field to
 * keep its current value.
 *
 * `runMinutes` is intentionally NOT patchable (start-time-only, never persisted).
 * Forcing a fresh run WITHOUT a mapping change is a separate imperative action —
 * POST /bots/:id/restart — not a flag here (that keeps PATCH declarative). The
 * botId comes from the path, not the body.
 */
export const updateBotSchema = z
  .object({
    gatewayId: z.string().min(1).optional(),
    personaName: z.string().min(1).optional(),
  })
  .refine((v) => v.gatewayId !== undefined || v.personaName !== undefined, {
    message: "provide at least one of: gatewayId, personaName",
  });

export type UpdateBotInput = z.infer<typeof updateBotSchema>;
