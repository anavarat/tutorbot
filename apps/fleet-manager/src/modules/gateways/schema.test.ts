import { describe, expect, it } from "vitest";

import { provisionGatewaySchema } from "./schema";

describe("provisionGatewaySchema", () => {
  it("accepts an empty body (both fields optional -> auto-allocate)", () => {
    expect(provisionGatewaySchema.safeParse({}).success).toBe(true);
  });

  it("accepts an explicit id and/or label", () => {
    expect(provisionGatewaySchema.safeParse({ gatewayId: "gw-eu-1" }).success).toBe(true);
    expect(provisionGatewaySchema.safeParse({ label: "EU west" }).success).toBe(true);
    expect(
      provisionGatewaySchema.safeParse({ gatewayId: "gw-eu-1", label: "EU west" }).success,
    ).toBe(true);
  });

  it("rejects empty strings (min length 1)", () => {
    expect(provisionGatewaySchema.safeParse({ gatewayId: "" }).success).toBe(false);
    expect(provisionGatewaySchema.safeParse({ label: "" }).success).toBe(false);
  });

  it("strips unknown fields", () => {
    const r = provisionGatewaySchema.safeParse({ gatewayId: "gw-1", junk: 1 });
    if (!r.success) throw new Error("expected parse to succeed");
    expect("junk" in r.data).toBe(false);
  });
});
