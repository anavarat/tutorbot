import { describe, expect, it } from "vitest";

import { createApp } from "./app.js";

describe("container app routes", () => {
  it("returns health contract for GET /health", async () => {
    const app = createApp();
    const response = await app.request(
      "https://example.com/health",
      {},
      {
        APP_ENV: "test",
        APP_VERSION: "2.0.0",
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      component: "container",
      env: "test",
      version: "2.0.0",
    });
  });

  it("returns readiness contract for GET /ready", async () => {
    const app = createApp();
    const response = await app.request("https://example.com/ready");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      component: "container",
      env: "dev-local",
      version: "0.0.0",
    });
  });
});
