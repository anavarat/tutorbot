import { describe, expect, it } from "vitest";

import { isLoginOtp, shouldIngestDm, type InboundMessageFields } from "./inbound-filter";

/** A plain inbound DM that SHOULD ingest; each test overrides one axis. */
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

describe("shouldIngestDm", () => {
  it("ingests a plain incoming text DM", () => {
    expect(shouldIngestDm(fields())).toEqual({ ingest: true });
  });

  it("skips group messages (DM-only scope)", () => {
    expect(shouldIngestDm(fields({ isGroup: true, chatId: "-100999" }))).toEqual({
      ingest: false,
      reason: "group",
    });
  });

  it("skips the bot's own outgoing echo", () => {
    expect(shouldIngestDm(fields({ isOutgoing: true }))).toEqual({
      ingest: false,
      reason: "outgoing",
    });
  });

  it("skips service/system messages", () => {
    expect(shouldIngestDm(fields({ isService: true, text: "" }))).toEqual({
      ingest: false,
      reason: "service",
    });
  });

  it("skips empty / media-only messages (is text-only)", () => {
    expect(shouldIngestDm(fields({ text: "   ", hasMedia: true, messageType: "media" }))).toEqual({
      ingest: false,
      reason: "empty_or_media_only",
    });
  });

  it("skips Telegram login/OTP codes", () => {
    expect(shouldIngestDm(fields({ text: "Login code: 72322. Do not give this code to anyone." }))).toEqual({
      ingest: false,
      reason: "login_otp",
    });
  });

  it("reports group before outgoing when both hold (first match wins)", () => {
    expect(shouldIngestDm(fields({ isGroup: true, isOutgoing: true }))).toEqual({
      ingest: false,
      reason: "group",
    });
  });
});

describe("isLoginOtp", () => {
  it("matches explicit Telegram login-code phrasing", () => {
    expect(isLoginOtp("Login code: 72322")).toBe(true);
    expect(isLoginOtp("This code can be used to log in to your Telegram account.")).toBe(true);
  });

  it("matches the digits+code+telegram heuristic", () => {
    expect(isLoginOtp("Your Telegram code is 55231, do not share")).toBe(true);
  });

  it("does not match an ordinary chat DM that merely contains a number", () => {
    expect(isLoginOtp("there are about 5000 stars visible tonight")).toBe(false);
    expect(isLoginOtp("hey are you there?")).toBe(false);
  });
});
