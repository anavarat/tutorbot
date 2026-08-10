import { DEFAULT_ENV, sharedVersion } from "./constants.js";

export type RuntimeComponent = "worker" | "container";

export interface RuntimeHealthResponse<TComponent extends RuntimeComponent> {
  ok: true;
  component: TComponent;
  env: string;
  version: string;
}

export interface RuntimeErrorResponse<TCode extends string> {
  ok: false;
  component: "worker";
  error: {
    code: TCode;
    message: string;
  };
}

export function resolveRuntimeHealth<TComponent extends RuntimeComponent>(
  component: TComponent,
  bindings?: {
    APP_ENV?: string;
    APP_VERSION?: string;
  },
): RuntimeHealthResponse<TComponent> {
  return {
    ok: true,
    component,
    env: bindings?.APP_ENV ?? DEFAULT_ENV,
    version: bindings?.APP_VERSION ?? sharedVersion,
  };
}
