import { describe, expect, it, vi } from "vitest";

import { generateReply } from "./llm";
import { cannedReply } from "./canned";
import type { PersonaPrompt } from "./persona";
import type { BotFleetEnv } from "../../types";

const persona: PersonaPrompt = {
  name: "Ada",
  subject: "Mathematics",
  tone: "warm and encouraging",
  greeting: "Hi there!",
};

/** Minimal fake env: only the members generateReply touches (AI + AI_GATEWAY_ID). */
function fakeEnv(opts: {
  gatewayId?: string;
  run?: (...args: unknown[]) => Promise<unknown>;
  ai?: boolean;
}): BotFleetEnv {
  const ai = opts.ai === false ? undefined : { run: opts.run ?? (async () => ({ response: "" })) };
  return { AI: ai, AI_GATEWAY_ID: opts.gatewayId } as unknown as BotFleetEnv;
}

describe("generateReply", () => {
  it("returns the canned line (no model call) when AI_GATEWAY_ID is unset", async () => {
    const run = vi.fn();
    const env = fakeEnv({ gatewayId: undefined, run });
    const out = await generateReply(env, persona, "what is a prime?");
    expect(run).not.toHaveBeenCalled();
    expect(out).toBe(cannedReply(persona, "what is a prime?"));
  });

  it("returns the canned line when the AI binding is absent", async () => {
    const env = fakeEnv({ gatewayId: "tutorbot-bot-fleet", ai: false });
    const out = await generateReply(env, persona, "hello");
    expect(out).toBe(cannedReply(persona, "hello"));
  });

  it("routes through the named gateway and returns the model text", async () => {
    const run = vi.fn(async () => ({ response: "A prime has exactly two divisors." }));
    const env = fakeEnv({ gatewayId: "tutorbot-bot-fleet", run });
    const out = await generateReply(env, persona, "what is a prime?");

    expect(out).toBe("A prime has exactly two divisors.");
    expect(run).toHaveBeenCalledTimes(1);
    const [model, inputs, options] = run.mock.calls[0] as unknown as [string, unknown, unknown];
    expect(model).toContain("llama");
    expect(options).toEqual({ gateway: { id: "tutorbot-bot-fleet" } });
    // system prompt carries the persona; user turn carries the inbound line.
    const messages = (inputs as { messages: Array<{ role: string; content: string }> }).messages;
    expect(messages[0].content).toContain("Mathematics");
    expect(messages[1].content).toBe("what is a prime?");
  });

  it("falls back to canned when the model call throws", async () => {
    const run = vi.fn(async () => {
      throw new Error("gateway 429");
    });
    const env = fakeEnv({ gatewayId: "tutorbot-bot-fleet", run });
    const out = await generateReply(env, persona, "hi");
    expect(out).toBe(cannedReply(persona, "hi"));
  });

  it("falls back to canned when the model returns empty text", async () => {
    const run = vi.fn(async () => ({ response: "   " }));
    const env = fakeEnv({ gatewayId: "tutorbot-bot-fleet", run });
    const out = await generateReply(env, persona, "hi");
    expect(out).toBe(cannedReply(persona, "hi"));
  });
});
