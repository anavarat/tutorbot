/**
 * DOMAIN (hexagonal core): PURE inbound-ingest policy. No I/O, no env, no
 * teleproto import — it takes ALREADY-EXTRACTED fields (the `platform/telegram`
 * adapter reads the raw `Api.Message`; this file never sees the SDK) and answers
 * a single question: should this DM be persisted for the bot to react to?
 *
 * scope is DM-reactive TEXT only. The filter mirrors the customer monolith's
 * `EventManager` gates (telegrambot `EventManager.ts` — group `:542`, system
 * `:318`, own `:696`, OTP `:341`) so we ingest exactly what the real product
 * ingests, minus the out-of-scope paths (groups, media). Every skip carries a
 * `reason` so the caller can log why a message was dropped without re-deriving it.
 */

/** Fields the adapter extracts from one `Api.Message` — no teleproto types leak here. */
export interface InboundMessageFields {
  /** Conversation id in the customer's format: DM = sender userId, group = `-…` (EventManager.ts:2219). */
  chatId: string;
  /** Telegram message id, stringified. */
  messageId: string;
  /** Text body (`message.message`); "" for media-only / service messages. */
  text: string;
  /** `message.out` — the bot's own outgoing echo. */
  isOutgoing: boolean;
  /** `message.action` present — a service/system message (join/title/… ). */
  isService: boolean;
  /** `message.media` present. */
  hasMedia: boolean;
  /** chatId starts with `-` (PeerChat/PeerChannel). */
  isGroup: boolean;
  /** Sender within a group; null in a 1:1 DM (Telegram omits fromId there). */
  senderId: string | null;
  /** Coarse type ("text" | "media" | "service" | "unknown"). */
  messageType: string;
}

export type FilterDecision = { ingest: true } | { ingest: false; reason: string };

/**
 * Telegram's own login/OTP codes arrive as a DM from the "Telegram" service
 * account. Ingesting them would (a) leak a live login code into Postgres and (b) make
 * the bot "reply" to Telegram. Ported verbatim from `EventManager.isLoginOtpMessage`
 * (telegrambot `EventManager.ts:341`).
 */
export function isLoginOtp(text: string): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();

  const patterns = [
    /login code:\s*\d+/i,
    /do not give this code to anyone/i,
    /this code can be used to log in to your telegram account/i,
    /if you didn't request this code/i,
    /even if they say they are from telegram/i,
  ];
  if (patterns.some((p) => p.test(text))) return true;

  // Heuristic: a 4+ digit code alongside "code"/"login" and "telegram"/"log in".
  return (
    /\d{4,}/.test(text) &&
    (lower.includes("code") || lower.includes("login")) &&
    (lower.includes("telegram") || lower.includes("log in"))
  );
}

/**
 * The one gate. Order matters only for the `reason` reported (first match wins);
 * the boolean outcome is order-independent. DM-only + text-only for.
 */
export function shouldIngestDm(m: InboundMessageFields): FilterDecision {
  if (m.isGroup) return { ingest: false, reason: "group" };
  if (m.isOutgoing) return { ingest: false, reason: "outgoing" };
  if (m.isService) return { ingest: false, reason: "service" };
  if (m.text.trim().length === 0) return { ingest: false, reason: "empty_or_media_only" };
  if (isLoginOtp(m.text)) return { ingest: false, reason: "login_otp" };
  return { ingest: true };
}
