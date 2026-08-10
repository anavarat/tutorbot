/**
 * DOMAIN — persona (teaching bot). A `PersonaPrompt` is the small, prompt-relevant
 * subset of a `persona` catalog row, decoupled from the DB schema: snake_case
 * columns are mapped to this camelCase shape by the platform adapter
 * (`platform/hyperdrive/persona-repo.ts`).
 *
 * This is a REDUCED, teaching-only persona: just enough voice to drive the reply.
 * It shapes the system prompt for the Workers AI reply (domain/reply/llm.ts) and
 * the deterministic fallback line (domain/reply/canned.ts). There is no scheduling
 * / active-hours slice and no multi-turn memory.
 */
export interface PersonaPrompt {
  /** Display name and catalog key, e.g. "Ada". */
  name: string;
  /** What this tutor teaches, e.g. "Mathematics". Drives the canned reply. */
  subject: string;
  /** One-line voice/tone hint, e.g. "warm and encouraging". */
  tone: string;
  /** Canned greeting line the bot opens with. */
  greeting: string;
}
