import { describe, expect, it } from "vitest";

import type { InboundMessageFields } from "../../domain/messaging/inbound-filter.js";
import type {
  TelegramClientAdapter,
  TelegramCreds,
  TelegramIdentity,
  UpdateState,
} from "../../platform/telegram/client.js";
import type { InboundParams, InboundResult } from "../messaging/store.js";
import { MessagingConnectionsService } from "./service.js";
import { connectionRegistry, type ConnectionRegistry } from "./state.js";

const IDENTITY: TelegramIdentity = { id: "8696677183", username: "bot_user", phone: "+100" };
const CREDS: TelegramCreds = { apiId: 123456, apiHash: "0123456789abcdef0123456789abcdef" };

/** A fake adapter that captures the inbound handler so a test can fire a message. */
class FakeAdapter {
  handler: ((f: InboundMessageFields) => void) | null = null;
  disconnected = false;
  reconnectCatchUpEnabled = false;
  restoredWith: Array<UpdateState | null> = [];
  /** what getUpdateState() returns to the throttled cursor-persist path. */
  cursor: UpdateState | null = { pts: 100, qts: 0, date: 1700000000, seq: 5 };
  async getMe(): Promise<TelegramIdentity> {
    return IDENTITY;
  }
  onNewMessage(h: (f: InboundMessageFields) => void): void {
    this.handler = h;
  }
  enableReconnectCatchUp(): void {
    this.reconnectCatchUpEnabled = true;
  }
  getUpdateState(): UpdateState | null {
    return this.cursor;
  }
  async restoreAndCatchUp(state: UpdateState | null): Promise<void> {
    this.restoredWith.push(state);
  }
  async disconnect(): Promise<void> {
    this.disconnected = true;
  }
}

/** A plain ingestable DM; tests override one axis. */
function fields(over: Partial<InboundMessageFields> = {}): InboundMessageFields {
  return {
    chatId: "12345",
    messageId: "678",
    text: "hey are you there?",
    isOutgoing: false,
    isService: false,
    hasMedia: false,
    isGroup: false,
    senderId: null,
    messageType: "text",
    ...over,
  };
}

function make() {
  const adapter = new FakeAdapter();
  const persistCalls: Array<{ dsn: string; params: InboundParams }> = [];
  const cursorReads: Array<{ dsn: string; botId: string }> = [];
  const cursorWrites: Array<{ dsn: string; botId: string; state: UpdateState }> = [];
  let persistError: Error | null = null;
  let savedCursor: UpdateState | null = null;
  let clock = 1_000_000;

  const svc = new MessagingConnectionsService({
    connect: async () => adapter as unknown as TelegramClientAdapter,
    creds: CREDS,
    registry: connectionRegistry as ConnectionRegistry,
    persistInbound: async (dsn: string, params: InboundParams): Promise<InboundResult> => {
      persistCalls.push({ dsn, params });
      if (persistError) throw persistError;
      return {
        chatId: "chat-1",
        messageId: "msg-1",
        ts: "2026-01-01T00:00:00Z",
        idempotencyKey: `telegram:${params.channelChatId}:${params.channelMessageId}`,
        duplicate: false,
      };
    },
    readUpdateState: async (dsn: string, botId: string): Promise<UpdateState | null> => {
      cursorReads.push({ dsn, botId });
      return savedCursor;
    },
    persistUpdateState: async (dsn: string, botId: string, state: UpdateState): Promise<void> => {
      cursorWrites.push({ dsn, botId, state });
    },
    now: () => clock,
  });

  return {
    svc,
    adapter,
    persistCalls,
    cursorReads,
    cursorWrites,
    setPersistError: (e: Error) => (persistError = e),
    setSavedCursor: (c: UpdateState | null) => (savedCursor = c),
    tick: (ms: number) => (clock += ms),
  };
}

/** Let the fire-and-forget cursor persist (void promise) settle. */
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("MessagingConnectionsService inbound", () => {
  it("connects, caches the connection, and registers an inbound handler", async () => {
    const { svc, adapter } = make();
    const res = await svc.connect("bot-1", "1AaStringSession==", "postgres://dsn");
    expect(res.kind).toBe("connected");
    expect(adapter.handler).toBeTypeOf("function");
    expect(connectionRegistry.get("bot-1")?.dsn).toBe("postgres://dsn");
    connectionRegistry.delete("bot-1");
  });

  it("persists an ingestable DM with the cached DSN + telegram channel fields", async () => {
    const { svc, adapter, persistCalls } = make();
    await svc.connect("bot-1", "s", "postgres://dsn");
    adapter.handler!(fields({ chatId: "999", messageId: "42", text: "hello" }));

    expect(persistCalls).toHaveLength(1);
    expect(persistCalls[0].dsn).toBe("postgres://dsn");
    expect(persistCalls[0].params).toMatchObject({
      botId: "bot-1",
      channel: "telegram",
      channelChatId: "999",
      channelMessageId: "42",
      content: "hello",
      isGroup: false,
    });
    connectionRegistry.delete("bot-1");
  });

  it("does NOT persist a filtered-out message (e.g. a group message)", async () => {
    const { svc, adapter, persistCalls } = make();
    await svc.connect("bot-1", "s", "postgres://dsn");
    adapter.handler!(fields({ isGroup: true, chatId: "-100999" }));
    expect(persistCalls).toHaveLength(0);
    connectionRegistry.delete("bot-1");
  });

  it("swallows a persist error so the socket is never torn down", async () => {
    const { svc, adapter, setPersistError } = make();
    await svc.connect("bot-1", "s", "postgres://dsn");
    setPersistError(new Error("Postgres down"));
    // Must not throw / reject.
    expect(() => adapter.handler!(fields())).not.toThrow();
    await Promise.resolve();
    connectionRegistry.delete("bot-1");
  });
});

describe("MessagingConnectionsService cold-start catch-up (P4b)", () => {
  it("wires reconnect catch-up and restores the persisted cursor on connect", async () => {
    const { svc, adapter, cursorReads, setSavedCursor } = make();
    const saved: UpdateState = { pts: 4242, qts: 7, date: 1699999999, seq: 3 };
    setSavedCursor(saved);

    await svc.connect("bot-1", "s", "postgres://dsn");

    expect(adapter.reconnectCatchUpEnabled).toBe(true); // P4a belt wired
    expect(cursorReads).toEqual([{ dsn: "postgres://dsn", botId: "bot-1" }]);
    expect(adapter.restoredWith).toEqual([saved]); // restored + catchUp replays down-window
    connectionRegistry.delete("bot-1");
  });

  it("restores null (baseline at now) for a fresh bot with no persisted cursor", async () => {
    const { svc, adapter } = make(); // savedCursor defaults to null
    await svc.connect("bot-1", "s", "postgres://dsn");
    expect(adapter.restoredWith).toEqual([null]);
    connectionRegistry.delete("bot-1");
  });

  it("does NOT touch Postgres for the cursor when there is no DSN (dev path)", async () => {
    const { svc, adapter, cursorReads } = make();
    await svc.connect("bot-1", "s", "");
    expect(cursorReads).toHaveLength(0);
    expect(adapter.restoredWith).toHaveLength(0);
    connectionRegistry.delete("bot-1");
  });
});

describe("MessagingConnectionsService update-cursor persistence", () => {
  it("persists the cursor at most once per throttle window, then again after it elapses", async () => {
    const { svc, adapter, cursorWrites, tick } = make();
    await svc.connect("bot-1", "s", "postgres://dsn");

    adapter.handler!(fields({ messageId: "1" }));
    adapter.handler!(fields({ messageId: "2" })); // same clock -> throttled out
    await flush();
    expect(cursorWrites).toHaveLength(1);
    expect(cursorWrites[0]).toMatchObject({ dsn: "postgres://dsn", botId: "bot-1" });

    tick(60_000);
    adapter.handler!(fields({ messageId: "3" }));
    await flush();
    expect(cursorWrites).toHaveLength(2);
    connectionRegistry.delete("bot-1");
  });

  it("advances the cursor even for a filtered-out (dropped) message", async () => {
    const { svc, adapter, cursorWrites, persistCalls } = make();
    await svc.connect("bot-1", "s", "postgres://dsn");

    adapter.handler!(fields({ isGroup: true, chatId: "-100999" }));
    await flush();
    expect(persistCalls).toHaveLength(0); // dropped, not ingested
    expect(cursorWrites).toHaveLength(1); // but the watermark still moved
    connectionRegistry.delete("bot-1");
  });

  it("skips the cursor persist when teleproto has not initialized the cursor yet", async () => {
    const { svc, adapter, cursorWrites } = make();
    adapter.cursor = null; // getUpdateState() -> null
    await svc.connect("bot-1", "s", "postgres://dsn");

    adapter.handler!(fields());
    await flush();
    expect(cursorWrites).toHaveLength(0);
    connectionRegistry.delete("bot-1");
  });
});

describe("MessagingConnectionsService disconnect (reassignment DETACH, B.5)", () => {
  it("tears the live socket down and drops it from the registry", async () => {
    const { svc, adapter } = make();
    await svc.connect("bot-1", "s", "postgres://dsn");
    expect(connectionRegistry.has("bot-1")).toBe(true);

    const res = await svc.disconnect("bot-1");
    expect(res).toEqual({ kind: "disconnected" });
    expect(adapter.disconnected).toBe(true);
    expect(connectionRegistry.has("bot-1")).toBe(false);
  });

  it("is idempotent: disconnecting an unknown/already-gone bot returns not_connected", async () => {
    const { svc } = make();
    const res = await svc.disconnect("bot-never-connected");
    expect(res).toEqual({ kind: "not_connected" });
  });

  it("still drops the registry entry when the socket close throws", async () => {
    const { svc, adapter } = make();
    await svc.connect("bot-1", "s", "postgres://dsn");
    adapter.disconnect = async () => {
      throw new Error("socket already dead");
    };

    const res = await svc.disconnect("bot-1");
    expect(res).toEqual({ kind: "disconnected" });
    expect(connectionRegistry.has("bot-1")).toBe(false);
  });
});
