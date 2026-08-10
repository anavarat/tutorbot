import type { PersonaPrompt } from "./persona";
import { cannedReply } from "./canned";
import type { BotFleetEnv } from "../../types";

/**
 * REPLY (reduced / teaching) — the ONE real model call in this build. Given the
 * bot's persona and the latest inbound line, produce a short reply with a single
 * Workers AI text-generation call, ROUTED THROUGH AN AI GATEWAY (so the call is
 * logged / cacheable / rate-limitable centrally).
 *
 * Teaching points:
 *   - The gateway is addressed by NAME via `{ gateway: { id } }` — the same name
 *     the IaC provisions (envs/shared AI Gateway). It is not a resource id that
 *     needs substitution; it is a stable name used directly.
 *   - Graceful degradation: if AI is unconfigured (no binding / no AI_GATEWAY_ID)
 *     or the call throws, we NEVER drop the reply — we fall back to the
 *     deterministic `cannedReply`. This keeps the end-to-end path (poll -> reply
 *     -> persist -> deliver) working even with AI turned off, and makes the loop
 *     safe to run in tests/local without a model.
 */

// Small, cheap instruct model — enough to demonstrate the gateway-routed call.
const REPLY_MODEL = "@cf/meta/llama-3.1-8b-instruct";
// Hard cap so a runaway generation can't bloat a Postgres message row.
const MAX_REPLY_CHARS = 600;

function buildSystemPrompt(persona: PersonaPrompt | null): string {
  if (!persona) {
    return (
      "You are a friendly, concise tutor. Answer the student's message in 2-3 " +
      "short sentences and invite a follow-up question. Plain text only."
    );
  }
  return (
    `You are ${persona.name}, a ${persona.subject} tutor. ` +
    `Voice/tone: ${persona.tone}. ` +
    `Open in the warm spirit of "${persona.greeting}", answer the student's message ` +
    `in 2-3 short sentences, stay strictly on ${persona.subject}, and end by inviting ` +
    `a follow-up question. Plain text only.`
  );
}

// Workers AI text-generation returns `{ response: string }` for the non-streaming
// path. Extract defensively so a shape change can't throw here.
function extractText(out: unknown): string {
  if (out && typeof out === "object" && "response" in out) {
    const r = (out as { response?: unknown }).response;
    if (typeof r === "string") return r.trim();
  }
  return "";
}

export async function generateReply(
  env: BotFleetEnv,
  persona: PersonaPrompt | null,
  inbound: string,
): Promise<string> {
  const gatewayId = env.AI_GATEWAY_ID?.trim();
  // No binding or no gateway configured -> deterministic reply (no model call).
  if (!env.AI || !gatewayId) return cannedReply(persona, inbound);

  try {
    const out = await env.AI.run(
      REPLY_MODEL,
      {
        messages: [
          { role: "system", content: buildSystemPrompt(persona) },
          { role: "user", content: inbound.trim().slice(0, 1000) },
        ],
        max_tokens: 256,
      },
      // Route through the AI Gateway by name. This is the whole point of the
      // shared AI Gateway resource in the IaC.
      { gateway: { id: gatewayId } },
    );
    const text = extractText(out);
    // Empty/odd model output -> fall back rather than deliver a blank reply.
    return text ? text.slice(0, MAX_REPLY_CHARS) : cannedReply(persona, inbound);
  } catch {
    // AI Gateway / model failure -> never drop the reply. Fall back to canned.
    return cannedReply(persona, inbound);
  }
}
