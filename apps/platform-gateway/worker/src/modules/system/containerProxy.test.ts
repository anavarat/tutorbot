import { beforeEach, describe, expect, it, vi } from "vitest";

const { getContainerMock } = vi.hoisted(() => ({
  getContainerMock: vi.fn(),
}));

vi.mock("@cloudflare/containers", () => ({
  Container: class {},
  getContainer: getContainerMock,
}));

import { proxyContainerRequest } from "./containerProxy.js";

describe("worker container proxy", () => {
  beforeEach(() => {
    getContainerMock.mockReset();
  });

  it("sanitizes a platform container-startup failure response and logs a Worker error event", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    getContainerMock.mockReturnValue({
      fetch: vi.fn(async () => new Response(
        "Failed to start container: Container exited with unexpected exit code: 1",
        {
          status: 500,
          headers: {
            "content-type": "text/plain;charset=UTF-8",
          },
        },
      )),
    });

    const response = await proxyContainerRequest(
      new Request("https://example.com/container/health", {
        headers: {
          "cf-ray": "test-ray-id",
        },
      }),
      {
        APP_ENV: "test",
        GATEWAY_CONTAINER: {} as never,
      },
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      component: "worker",
      error: {
        code: "CONTAINER_REQUEST_FAILED",
        message: "Failed to start container: Container exited with unexpected exit code: 1",
      },
    });
    // Now emitted as a single structured stage-log line (JSON string), not a
    // (tag, object) console call. Parse it and assert the envelope + details.
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(consoleErrorSpy.mock.calls[0][0] as string) as Record<string, unknown>;
    expect(logged).toMatchObject({
      level: "error",
      stage: "forward.fail",
      message: "container request failed",
      cf_ray: "test-ray-id",
      svc: "gw-worker",
      details: {
        route: "/container/health",
        internal_path: "/health",
        container_name: "gateway-default",
        app_env: "test",
        error_message: "Failed to start container: Container exited with unexpected exit code: 1",
      },
    });
    // No inbound x-request-id in this request -> a fresh UUID is minted.
    expect(typeof logged.request_id).toBe("string");

    consoleErrorSpy.mockRestore();
  });
});
