import { buildReplyKey, deriveRandomId } from "@tutorbot/shared";
import { describe, expect, it } from "vitest";

import type { TelegramClientAdapter } from "../../platform/telegram/client.js";
import { OutboundService, type OutboundStamper } from "./outbound.js";
import type { ChannelConnection, ConnectionRegistry } from "./state.js";

const REPLY_KEY = buildReplyKey("telegram:999:42");
const DSN = "postgres://dsn";

/** Captures the last sendMessage call (incl. the / stable random_id) and
 *  returns a canned real id (or throws). */
class FakeClient {
  sent: Array<{ chatId: string; text: string; randomId?: bigint }> = [];
  constructor(private readonly opts: { realId?: string; throwOn?: boolean } = {}) {}
  async sendMessage(chatId: string, text: string, randomId?: bigint): Promise<string> {
    this.sent.push({ chatId, text, randomId });
    if (this.opts.throwOn) throw new Error("socket send failed");
    return this.opts.realId ?? "tg-msg-1";
  }
}

/** A registry pre-seeded with (or without) one bot's live connection. */
function registryWith(botId: string, client: FakeClient | null): ConnectionRegistry {
  const map = new Map<string, ChannelConnection>();
  if (client) {
    map.set(botId, {
      client: client as unknown as TelegramClientAdapter,
      botId,
      dsn: DSN,
    });
  }
  return {
    get: (id) => map.get(id),
    set: (id, c) => void map.set(id, c),
    has: (id) => map.has(id),
    delete: (id) => map.delete(id),
    size: () => map.size,
  };
}

function make(opts: { client: FakeClient | null; fresh?: boolean; stampThrows?: boolean }) {
  const stampCalls: Array<{ dsn: string; botId: string; key: string; channelMessageId: string }> =
    [];
  const stamp: OutboundStamper = async (dsn, botId, key, channelMessageId) => {
    stampCalls.push({ dsn, botId, key, channelMessageId });
    if (opts.stampThrows) throw new Error("Postgres stamp failed");
    return opts.fresh ?? true;
  };
  const svc = new OutboundService({
    registry: registryWith("bot-1", opts.client),
    stamp,
  });
  return { svc, stampCalls };
}

describe("OutboundService.sendReply", () => {
  it("sends to the chatId parsed from the reply key, then stamps -> sent (fresh)", async () => {
    const client = new FakeClient({ realId: "tg-777" });
    const { svc, stampCalls } = make({ client, fresh: true });

    const res = await svc.sendReply("bot-1", REPLY_KEY, "hi back", DSN);

    expect(res).toEqual({ kind: "sent", channelMessageId: "tg-777", duplicate: false });
    //: the send carries the STABLE random_id derived from the reply key.
    expect(client.sent).toEqual([
      { chatId: "999", text: "hi back", randomId: deriveRandomId(REPLY_KEY) },
    ]);
    expect(stampCalls).toEqual([
      { dsn: DSN, botId: "bot-1", key: REPLY_KEY, channelMessageId: "tg-777" },
    ]);
  });

  it("passes the SAME random_id on a re-drive of the same reply key (server-dedup basis)", async () => {
    const c1 = new FakeClient();
    const c2 = new FakeClient();
    await make({ client: c1 }).svc.sendReply("bot-1", REPLY_KEY, "hi", DSN);
    await make({ client: c2 }).svc.sendReply("bot-1", REPLY_KEY, "hi", DSN);
    expect(c1.sent[0].randomId).toBe(c2.sent[0].randomId);
    expect(typeof c1.sent[0].randomId).toBe("bigint");
  });

  it("marks duplicate=true when the stamp is an idempotent no-op (redelivery)", async () => {
    const { svc } = make({ client: new FakeClient(), fresh: false });
    const res = await svc.sendReply("bot-1", REPLY_KEY, "hi", DSN);
    expect(res).toEqual({ kind: "sent", channelMessageId: "tg-msg-1", duplicate: true });
  });

  it("returns not_connected when the bot has no live connection (no send, no stamp)", async () => {
    const { svc, stampCalls } = make({ client: null });
    const res = await svc.sendReply("bot-1", REPLY_KEY, "hi", DSN);
    expect(res).toEqual({ kind: "not_connected" });
    expect(stampCalls).toHaveLength(0);
  });

  it("returns send_failed (no stamp) when the socket send throws", async () => {
    const { svc, stampCalls } = make({ client: new FakeClient({ throwOn: true }) });
    const res = await svc.sendReply("bot-1", REPLY_KEY, "hi", DSN);
    expect(res).toMatchObject({ kind: "send_failed", error: "socket send failed" });
    expect(stampCalls).toHaveLength(0);
  });

  it("returns send_failed (no send) on a malformed reply key", async () => {
    const client = new FakeClient();
    const { svc } = make({ client });
    const res = await svc.sendReply("bot-1", "not-a-reply-key", "hi", DSN);
    expect(res).toMatchObject({ kind: "send_failed" });
    expect(client.sent).toHaveLength(0);
  });

  it("propagates a stamp throw (send already happened -> caller maps to 500)", async () => {
    const { svc } = make({ client: new FakeClient(), stampThrows: true });
    await expect(svc.sendReply("bot-1", REPLY_KEY, "hi", DSN)).rejects.toThrow("Postgres stamp failed");
  });
});
