import type { PersonaPrompt } from "./persona";

/**
 * REPLY (reduced / teaching). A deterministic, per-persona canned reply — the
 * dumbed-down stand-in for a generated reply. No model call, no history, no
 * outbox: given the latest inbound line and the bot's persona, return a fixed
 * template. Pure and side-effect-free, so it is trivially testable and free.
 *
 * With a persona the bot answers in-character as a subject tutor; with none it
 * falls back to a generic tutor voice. Kept intentionally simple: this is where a
 * real implementation would plug in an LLM, but for the teaching build a template
 * is enough to demonstrate the end-to-end path (poll -> reply -> deliver).
 */
export function cannedReply(persona: PersonaPrompt | null, inbound: string): string {
  const trimmed = inbound.trim().slice(0, 280);
  if (!persona) {
    return `Thanks for your message! You said: "${trimmed}". Ask me anything and I'll try to help you learn.`;
  }
  return (
    `${persona.greeting} I'm ${persona.name}, your ${persona.subject} tutor. ` +
    `You said: "${trimmed}". Let's explore that — what would you like to understand about ${persona.subject}?`
  );
}
