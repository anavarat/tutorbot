import { beforeEach, describe, expect, it, vi } from "vitest";

const { getContainerMock } = vi.hoisted(() => ({
  getContainerMock: vi.fn(),
}));

vi.mock("@cloudflare/containers", () => ({
  Container: class {},
  getContainer: getContainerMock,
}));

import { createApp } from "./app.js";

describe("worker app routes", () => {
  beforeEach(() => {
    getContainerMock.mockReset();
  });

  it("returns the accepted health contract from Worker bindings", async () => {
    const app = createApp();
    const response = await app.request(
      "https://example.com/health",
      {},
      {
        APP_ENV: "test",
        APP_VERSION: "1.2.3",
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      component: "worker",
      env: "test",
      version: "1.2.3",
    });
  });

  it("uses scaffold defaults when bindings are absent", async () => {
    const app = createApp();
    const response = await app.request("https://example.com/health");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      component: "worker",
      env: "dev-local",
      version: "0.0.0",
    });
  });

  it("proxies GET /container/health through the named container instance", async () => {
    const app = createApp();
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          ok: true,
          component: "container",
          env: "test",
          version: "9.9.9",
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        },
      ));

    getContainerMock.mockReturnValue({
      fetch: fetchMock,
    });

    const response = await app.request(
      "https://example.com/container/health",
      {},
      {
        APP_ENV: "test",
        APP_VERSION: "1.2.3",
        GATEWAY_CONTAINER: {} as never,
      },
    );

    expect(getContainerMock).toHaveBeenCalledTimes(1);
    expect(getContainerMock).toHaveBeenCalledWith(expect.anything(), "gateway-default");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(new URL(fetchMock.mock.calls[0][0].url).pathname).toBe("/health");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      component: "container",
      env: "test",
      version: "9.9.9",
    });
  });

  it("proxies GET /container/ready through the named container instance", async () => {
    const app = createApp();
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          ok: true,
          component: "container",
          env: "dev-local",
          version: "0.0.0",
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        },
      ));

    getContainerMock.mockReturnValue({
      fetch: fetchMock,
    });

    const response = await app.request(
      "https://example.com/container/ready",
      {},
      {
        GATEWAY_CONTAINER: {} as never,
      },
    );

    expect(getContainerMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(new URL(fetchMock.mock.calls[0][0].url).pathname).toBe("/ready");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      component: "container",
      env: "dev-local",
      version: "0.0.0",
    });
  });
});
