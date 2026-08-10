import { getContainer } from "@cloudflare/containers";
import {
  CONTAINER_REQUEST_FAILED,
  DEFAULT_ENV,
} from "@tutorbot/shared";

import { createCorrelationContext, createStageLogger } from "@tutorbot/shared/observability";
import {
  type ErrorResponse,
  type WorkerBindings,
} from "./contracts.js";

const DEFAULT_CONTAINER_NAME = "gateway-default";
const CONTAINER_ROUTE_MAP = {
  "/container/health": "/health",
  "/container/ready": "/ready",
  // Raw container OpenAPI spec, proxied from the DEFAULT container so the
  // /container/docs viewer (worker-owned HTML) can point Scalar at the REAL
  // container spec. Docs are identical across containers (same image), so the
  // default instance is fine — no gatewayId needed.
  "/container/openapi.yaml": "/openapi.yaml",
} as const;

function getGatewayContainerStub(env: WorkerBindings) {
  if (!env.GATEWAY_CONTAINER) {
    throw new Error("GATEWAY_CONTAINER binding is not configured");
  }

  return getContainer(env.GATEWAY_CONTAINER as never, DEFAULT_CONTAINER_NAME);
}

function buildContainerFailureResponse(message = "Container request failed"): Response {
  const body: ErrorResponse = {
    ok: false,
    component: "worker",
    error: {
      code: CONTAINER_REQUEST_FAILED,
      message,
    },
  };

  return Response.json(body, { status: 500 });
}

function logContainerRequestFailure(
  request: Request,
  env: WorkerBindings,
  internalPath: string,
  error: unknown,
): void {
  const requestUrl = new URL(request.url);
  const errorMessage = error instanceof Error ? error.message : String(error);

  // Honours inbound x-request-id + captures cf-ray, so this failure line stitches
  // to whatever upstream call triggered the container proxy.
  const correlation = createCorrelationContext(request);
  createStageLogger({ context: { svc: "gw-worker" }, correlation }).error(
    "forward.fail",
    "container request failed",
    {
      route: requestUrl.pathname,
      internal_path: internalPath,
      container_name: DEFAULT_CONTAINER_NAME,
      app_env: env.APP_ENV ?? DEFAULT_ENV,
      error_message: errorMessage,
    },
  );
}

async function getContainerFailureMessage(response: Response): Promise<string | null> {
  if (response.ok || response.status < 500) {
    return null;
  }

  const contentType = response.headers.get("content-type") ?? "";

  if (!contentType.startsWith("text/plain")) {
    return null;
  }

  const responseText = await response.clone().text();

  if (!responseText.startsWith("Failed to start container: ")) {
    return null;
  }

  return responseText;
}

export async function proxyContainerRequest(
  request: Request,
  env: WorkerBindings,
): Promise<Response> {
  const requestUrl = new URL(request.url);
  const internalPath = CONTAINER_ROUTE_MAP[requestUrl.pathname as keyof typeof CONTAINER_ROUTE_MAP];

  if (!internalPath) {
    return new Response("Container route mapping not found", { status: 500 });
  }

  try {
    const container = getGatewayContainerStub(env);

    requestUrl.pathname = internalPath;
    requestUrl.search = "";

    const containerRequest = new Request(requestUrl.toString(), request);
    const response = await container.fetch(containerRequest);
    const containerFailureMessage = await getContainerFailureMessage(response);

    if (!containerFailureMessage) {
      return response;
    }

    logContainerRequestFailure(request, env, internalPath, containerFailureMessage);
    return buildContainerFailureResponse(containerFailureMessage);
  } catch (error) {
    logContainerRequestFailure(request, env, internalPath, error);
    return buildContainerFailureResponse();
  }
}
