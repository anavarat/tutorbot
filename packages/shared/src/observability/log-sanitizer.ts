type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { readonly [key: string]: JsonValue };

/**
 * Field-name denylist. Any log field whose (normalised) name is in this set is
 * replaced with "[redacted]" — recursively, including nested objects and arrays.
 *
 * Names are matched case-insensitively with "-" and "_" stripped, so
 * `channel_sender_id`, `channelSenderId` and `channel-sender-id` all collapse to
 * `channelsenderid` and are caught by a single entry.
 *
 * IMPORTANT: the identifiers we DELIBERATELY log survive, on purpose:
 *   messageId -> "messageid", channel_message_id -> "channelmessageid",
 *   idempotencyKey -> "idempotencykey", chatId -> "chatid", botId, gatewayId.
 * Only message *content*, contact PII, and secrets are redacted.
 */
const sensitiveFieldNames = new Set([
  // --- generic secrets / auth / prompts (from insightsradar) ---
  "access_token",
  "authorization",
  "body",
  "cfaccessclientid",
  "cfaccessclientsecret",
  "cfaccessjwtassertion",
  "cfauthorization",
  "cf-access-jwt-assertion",
  "cookie",
  "generatedartifact",
  "identityclaims",
  "password",
  "prompt",
  "rawidentityclaims",
  "rawprompt",
  "request_body",
  "secret",
  "token",
  "transcript",
  "userclaims",
  // --- tutorbot: message content ---
  "content",
  "text",
  "message",
  "msg",
  "caption",
  // --- tutorbot: contact PII ---
  "pushname",
  "displayname",
  "jid",
  "remotejid",
  "participant",
  "participantjid",
  "phone",
  "phonenumber",
  "msisdn",
  "sender",
  "senderid",
  "channelsenderid",
  // --- tutorbot: channel auth / connection secrets ---
  "pairingcode",
  "qr",
  "qrcode",
  "dsn",
  "connectionstring",
  "supabaseconnectionstring",
  "supabasepassword",
  "databaseurl",
  "apikey",
]);

export function sanitizeLogDetails(
  details: Record<string, unknown>,
): Record<string, JsonValue> {
  const sanitized: Record<string, JsonValue> = {};

  for (const [key, value] of Object.entries(details)) {
    sanitized[key] = sanitizeLogValue(key, value);
  }

  return sanitized;
}

function sanitizeLogValue(key: string, value: unknown): JsonValue {
  if (isSensitiveFieldName(key)) {
    return "[redacted]";
  }

  if (value === null) {
    return null;
  }

  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeLogValue(key, item));
  }

  if (typeof value === "object") {
    const result: Record<string, JsonValue> = {};

    for (const [nestedKey, nestedValue] of Object.entries(value as Record<string, unknown>)) {
      result[nestedKey] = sanitizeLogValue(nestedKey, nestedValue);
    }

    return result;
  }

  return String(value);
}

function isSensitiveFieldName(key: string): boolean {
  return (
    sensitiveFieldNames.has(key.replaceAll(/[-_]/g, "").toLowerCase()) ||
    sensitiveFieldNames.has(key.toLowerCase())
  );
}
