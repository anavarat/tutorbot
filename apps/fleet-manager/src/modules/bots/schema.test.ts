import { describe, expect, it } from "vitest";

import { provisionSchema, updateBotSchema } from "./schema";

/** The per-bot Telegram credential quad, now REQUIRED on every provision. */
const CREDS = {
  apiId: 123456,
  apiHash: "0123456789abcdef0123456789abcdef",
  phone: "+447700900000",
  sessionCredential: "1AaBbCcStringSession==",
};

describe("provisionSchema", () => {
  it("accepts a minimal valid body (gatewayId + creds)", () => {
    const r = provisionSchema.safeParse({ gatewayId: "gw-1", ...CREDS });
    expect(r.success).toBe(true);
  });

  it("requires gatewayId", () => {
    expect(provisionSchema.safeParse({ ...CREDS }).success).toBe(false);
    expect(provisionSchema.safeParse({ gatewayId: "", ...CREDS }).success).toBe(false);
  });

  it("requires the full telegram credential quad", () => {
    expect(provisionSchema.safeParse({ gatewayId: "gw-1" }).success).toBe(false);
    // each field missing => reject
    expect(
      provisionSchema.safeParse({ gatewayId: "gw-1", apiHash: "h", phone: "+1", sessionCredential: "s" }).success,
    ).toBe(false); // no apiId
    expect(
      provisionSchema.safeParse({ gatewayId: "gw-1", apiId: 1, phone: "+1", sessionCredential: "s" }).success,
    ).toBe(false); // no apiHash
    expect(
      provisionSchema.safeParse({ gatewayId: "gw-1", apiId: 1, apiHash: "h", sessionCredential: "s" }).success,
    ).toBe(false); // no phone
    expect(
      provisionSchema.safeParse({ gatewayId: "gw-1", apiId: 1, apiHash: "h", phone: "+1" }).success,
    ).toBe(false); // no sessionCredential
  });

  it("coerces a string api_id to a number (form inputs arrive as strings)", () => {
    const r = provisionSchema.safeParse({ gatewayId: "gw-1", ...CREDS, apiId: "654321" });
    if (!r.success) throw new Error("expected parse to succeed");
    expect(r.data.apiId).toBe(654321);
  });

  it("rejects a non-positive / non-numeric api_id", () => {
    expect(provisionSchema.safeParse({ gatewayId: "gw-1", ...CREDS, apiId: 0 }).success).toBe(false);
    expect(provisionSchema.safeParse({ gatewayId: "gw-1", ...CREDS, apiId: "abc" }).success).toBe(false);
  });

  it("rejects an empty personaName and non-positive runMinutes", () => {
    expect(provisionSchema.safeParse({ gatewayId: "gw-1", ...CREDS, personaName: "" }).success).toBe(false);
    expect(provisionSchema.safeParse({ gatewayId: "gw-1", ...CREDS, runMinutes: 0 }).success).toBe(false);
    expect(provisionSchema.safeParse({ gatewayId: "gw-1", ...CREDS, runMinutes: -5 }).success).toBe(false);
  });

  it("accepts the full valid body", () => {
    const r = provisionSchema.safeParse({
      botId: "bot-1",
      gatewayId: "gw-1",
      personaName: "Tanya",
      runMinutes: 90,
      force: true,
      ...CREDS,
    });
    expect(r.success).toBe(true);
  });

  it("strips unknown fields", () => {
    const r = provisionSchema.safeParse({ gatewayId: "gw-1", ...CREDS, junk: 123 });
    if (!r.success) throw new Error("expected parse to succeed");
    expect("junk" in r.data).toBe(false);
  });
});

describe("updateBotSchema", () => {
  it("accepts a gateway-only patch", () => {
    expect(updateBotSchema.safeParse({ gatewayId: "gw-2" }).success).toBe(true);
  });

  it("accepts a persona-only patch", () => {
    expect(updateBotSchema.safeParse({ personaName: "New" }).success).toBe(true);
  });

  it("rejects an empty patch", () => {
    expect(updateBotSchema.safeParse({}).success).toBe(false);
  });

  it("accepts gateway + persona together", () => {
    expect(updateBotSchema.safeParse({ gatewayId: "gw-2", personaName: "New" }).success).toBe(true);
  });

  it("strips an unknown restart field (no longer part of the mapping patch)", () => {
    const parsed = updateBotSchema.safeParse({ gatewayId: "gw-2", restart: true });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect("restart" in parsed.data).toBe(false);
  });

  it("rejects an empty gatewayId", () => {
    expect(updateBotSchema.safeParse({ gatewayId: "" }).success).toBe(false);
  });
});
