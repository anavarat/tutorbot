import { describe, expect, it } from "vitest";

import { buildInboundKey, buildReplyKey, deriveRandomId, parseReplyKey } from "./keys.js";

describe("idempotency-key contract", () => {
  it("round-trips inbound -> reply -> parsed parts", () => {
    const inbound = buildInboundKey("telegram", "12345", "678");
    expect(inbound).toBe("telegram:12345:678");
    const reply = buildReplyKey(inbound);
    expect(reply).toBe("reply:telegram:12345:678");
    expect(parseReplyKey(reply)).toEqual({
      channel: "telegram",
      channelChatId: "12345",
      channelMessageId: "678",
    });
  });

  it("keeps a channelMessageId that itself contains ':' intact", () => {
    const reply = buildReplyKey(buildInboundKey("telegram", "jid@s.telegram.net", "a:b:c"));
    expect(parseReplyKey(reply).channelMessageId).toBe("a:b:c");
  });
});

describe("deriveRandomId (stable send dedup id)", () => {
  it("is deterministic: same key -> same id (this is the whole point)", () => {
    const key = "reply:telegram:999:42";
    expect(deriveRandomId(key)).toBe(deriveRandomId(key));
  });

  it("differs for different keys", () => {
    expect(deriveRandomId("reply:telegram:999:42")).not.toBe(
      deriveRandomId("reply:telegram:999:43"),
    );
    expect(deriveRandomId("reply:telegram:999:42")).not.toBe(
      deriveRandomId("reply:telegram:1000:42"),
    );
  });

  it("stays within signed int64 range (the wire 'long')", () => {
    const MIN = -(2n ** 63n);
    const MAX = 2n ** 63n - 1n;
    for (const k of ["a", "reply:telegram:1:1", "reply:telegram:jid:xyz", "".padEnd(500, "z")]) {
      const id = deriveRandomId(k);
      expect(typeof id).toBe("bigint");
      expect(id >= MIN && id <= MAX).toBe(true);
    }
  });
});
