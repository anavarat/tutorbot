import { describe, expect, it, vi } from "vitest";

import { resolveContainerHealth } from "./contracts.js";
import { logContainerStartup, registerSigtermHandler } from "./lifecycle.js";

describe("container lifecycle helpers", () => {
  it("resolves container health from bindings", () => {
    expect(resolveContainerHealth({
      APP_ENV: "staging",
      APP_VERSION: "3.1.4",
    })).toEqual({
      ok: true,
      component: "container",
      env: "staging",
      version: "3.1.4",
    });
  });

  it("logs startup with resolved health fields", () => {
    const logger = {
      info: vi.fn(),
    };

    logContainerStartup(logger, {
      APP_ENV: "staging",
      APP_VERSION: "3.1.4",
    });

    expect(logger.info).toHaveBeenCalledWith("lifecycle.startup", "container started", {
      env: "staging",
      version: "3.1.4",
    });
  });

  it("registers and disposes SIGTERM handling", () => {
    const listeners = new Map<string, () => void>();
    const logger = {
      info: vi.fn(),
    };
    const onShutdown = vi.fn();
    const processLike = {
      on: vi.fn((event: "SIGTERM", listener: () => void) => {
        listeners.set(event, listener);
      }),
      off: vi.fn((event: "SIGTERM") => {
        listeners.delete(event);
      }),
    };

    const dispose = registerSigtermHandler(processLike, logger, onShutdown);

    expect(processLike.on).toHaveBeenCalledTimes(1);
    listeners.get("SIGTERM")?.();

    expect(logger.info).toHaveBeenCalledWith("lifecycle.sigterm", "received SIGTERM");
    expect(onShutdown).toHaveBeenCalledTimes(1);

    dispose();

    expect(processLike.off).toHaveBeenCalledTimes(1);
    expect(listeners.has("SIGTERM")).toBe(false);
  });
});
