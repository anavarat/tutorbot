import {
  resolveRuntimeHealth,
  type RuntimeHealthResponse,
} from "@tutorbot/shared";

export interface ContainerBindings {
  APP_ENV?: string;
  APP_VERSION?: string;
}

export type ContainerHealthResponse = RuntimeHealthResponse<"container">;

/**
 * Minimal stage-logger shape the lifecycle helpers depend on. A real
 * `createStageLogger(...)` satisfies this structurally; unit tests inject a fake
 * `{ info: vi.fn() }`. Signature matches StageLogger.info: (stage, message, details?).
 */
export interface LoggerLike {
  info: (stage: string, message: string, details?: Record<string, unknown>) => void;
}

export interface ProcessLike {
  on: (event: "SIGTERM", listener: () => void) => void;
  off?: (event: "SIGTERM", listener: () => void) => void;
  removeListener?: (event: "SIGTERM", listener: () => void) => void;
}

export function resolveContainerHealth(bindings?: ContainerBindings): ContainerHealthResponse {
  return resolveRuntimeHealth("container", bindings);
}
