import type { PersonaPrompt } from "./persona";

/**
 * REPLY FALLBACK (reduced / teaching). A deterministic, per-persona canned reply.
 * This is the fallback for the Workers AI reply (domain/reply/llm.ts): when AI is
 * unconfigured (no AI_GATEWAY_ID) or the model call fails, `generateReply` returns
 * this instead so the loop never drops a reply. No model call, no history: given
 * the latest inbound line and the bot's persona, return a fixed template. Pure and
 * side-effect-free, so it is trivially testable and free.
 *
 * With a persona the bot answers in-character as a subject tutor; with none it
 * falls back to a generic tutor voice.
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
