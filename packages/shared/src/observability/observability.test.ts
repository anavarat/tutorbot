import { describe, expect, it } from "vitest";

import {
  createCorrelationContext,
  createStageLogRecord,
  sanitizeLogDetails,
} from "./index.js";

describe("observability helpers", () => {
  it("uses an inbound x-request-id when one is provided", () => {
    const request = new Request("https://example.test/inbound", {
      headers: { "x-request-id": "req_existing" },
    });

    expect(createCorrelationContext(request).request_id).toBe("req_existing");
  });

  it("generates a request id and captures cf_ray when available", () => {
    const request = new Request("https://example.test/inbound", {
      headers: { "cf-ray": "abc123-SYD" },
    });

    expect(createCorrelationContext(request, () => "req_generated")).toEqual({
      request_id: "req_generated",
      cf_ray: "abc123-SYD",
    });
  });

  it("redacts message content, contact PII and secrets recursively", () => {
    expect(
      sanitizeLogDetails({
        chatId: 1,
        content: "hello there",
        pushName: "Jane Doe",
        channelSenderId: "15551234567@s.telegram.net",
        nested: { text: "secret text", status: "ok" },
        supabaseConnectionString: "postgres://u:p@host/db",
      }),
    ).toEqual({
      chatId: 1,
      content: "[redacted]",
      pushName: "[redacted]",
      channelSenderId: "[redacted]",
      nested: { text: "[redacted]", status: "ok" },
      supabaseConnectionString: "[redacted]",
    });
  });

  it("preserves the identifiers we intentionally log", () => {
    expect(
      sanitizeLogDetails({
        botId: "bot-7",
        gatewayId: "gw-2",
        chatId: 1,
        messageId: 3,
        channelMessageId: "169-1",
        idempotencyKey: "wa:dm:tester:169",
      }),
    ).toEqual({
      botId: "bot-7",
      gatewayId: "gw-2",
      chatId: 1,
      messageId: 3,
      channelMessageId: "169-1",
      idempotencyKey: "wa:dm:tester:169",
    });
  });

  it("builds a record with context merged top-level and details sanitized", () => {
    expect(
      createStageLogRecord({
        level: "info",
        stage: "inbound.insert",
        message: "stored inbound message",
        correlation: { request_id: "req_123", cf_ray: "abc-SYD" },
        context: { svc: "gw-container", gatewayId: "gw-2", botId: "bot-7" },
        details: { chatId: 1, messageId: 3, content: "hi", duplicate: false },
      }),
    ).toEqual({
      level: "info",
      stage: "inbound.insert",
      message: "stored inbound message",
      request_id: "req_123",
      cf_ray: "abc-SYD",
      svc: "gw-container",
      gatewayId: "gw-2",
      botId: "bot-7",
      details: { chatId: 1, messageId: 3, content: "[redacted]", duplicate: false },
    });
  });

  it("omits correlation fields for the self-driven loop (no request)", () => {
    const record = createStageLogRecord({
      level: "debug",
      stage: "loop.poll",
      message: "poll tick",
      context: { svc: "bot-fleet", botId: "bot-7", runId: "run_ab12" },
      details: { cursor: 0 },
    });

    expect(record.request_id).toBeUndefined();
    expect(record).toEqual({
      level: "debug",
      stage: "loop.poll",
      message: "poll tick",
      svc: "bot-fleet",
      botId: "bot-7",
      runId: "run_ab12",
      details: { cursor: 0 },
    });
  });
});
