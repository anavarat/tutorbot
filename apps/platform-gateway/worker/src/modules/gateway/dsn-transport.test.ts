import { beforeEach, describe, expect, it, vi } from "vitest";

import { DB_DSN_FIELD } from "@tutorbot/shared";

// Capture the Request the Worker forwards to the container. getContainer is the
// only external seam; the rest (roster, DSN) is driven purely via the fake env.
const { getContainerMock } = vi.hoisted(() => ({ getContainerMock: vi.fn() }));
vi.mock("@cloudflare/containers", () => ({ Container: class {}, getContainer: getContainerMock }));

import { createGatewayRouter } from "./routes.js";
import type { WorkerBindings } from "../system/contracts.js";

const EXPECTED_DSN = "postgresql://user:s3cr3t@db.example.co:5432/postgres";

/** Fake env: FLEET_MANAGER returns an active gw-1 roster; Postgres vars + a
 *  Secrets-Store stub let getDsn assemble EXPECTED_DSN. */
function makeEnv(): WorkerBindings {
  return {
    GATEWAY_CONTAINER: {} as never,
    FLEET_MANAGER: {
      fetch: async () =>
        new Response(JSON.stringify({ gateways: [{ gateway_id: "gw-1", status: "active" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    },
    DB_PASSWORD: { get: async () => "s3cr3t" },
    DB_USER: "user",
    DB_HOST: "db.example.co",
    DB_PORT: "5432",
    DB_NAME: "postgres",
  } as unknown as WorkerBindings;
}

describe("gateway DSN transport (Option B: request body, never a header)", () => {
  let captured: Request | null;

  beforeEach(() => {
    captured = null;
    getContainerMock.mockReset();
    getContainerMock.mockReturnValue({
      fetch: async (req: Request) => {
        captured = req;
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
  });

  it("POST /connection/connect carries the DSN in the body, not a header or the URL", async () => {
    const res = await createGatewayRouter().request(
      "https://gw.example.com/connection/connect",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          gatewayId: "gw-1",
          botId: "bot-1",
          sessionCredential: "sess",
        }),
      },
      makeEnv(),
    );

    expect(res.status).toBe(200);
    expect(captured).not.toBeNull();
    // secret NOT in a header (invocation logs capture headers)
    expect(captured!.headers.get("x-db-dsn")).toBeNull();
    // secret NOT in the URL (invocation logs capture the URL)
    expect(captured!.url).not.toContain("s3cr3t");
    expect(new URL(captured!.url).pathname).toBe("/connection/connect");
    // secret rides in the body; domain fields intact
    const fwd = (await captured!.clone().json()) as Record<string, unknown>;
    expect(fwd[DB_DSN_FIELD]).toBe(EXPECTED_DSN);
    expect(fwd.botId).toBe("bot-1");
  });

  it("POST /outbound carries the DSN in the body of the /deliver forward", async () => {
    const res = await createGatewayRouter().request(
      "https://gw.example.com/outbound",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ gatewayId: "gw-1", botId: "bot-1", content: "reply", idempotencyKey: "k1" }),
      },
      makeEnv(),
    );

    expect(res.status).toBe(200);
    expect(captured!.headers.get("x-db-dsn")).toBeNull();
    expect(captured!.url).not.toContain("s3cr3t");
    expect(new URL(captured!.url).pathname).toBe("/deliver");
    const fwd = (await captured!.clone().json()) as Record<string, unknown>;
    expect(fwd[DB_DSN_FIELD]).toBe(EXPECTED_DSN);
    expect(fwd.idempotencyKey).toBe("k1");
  });

  it("GET /gateways/:id/connections (non-DB route) never carries the DSN — no header, no body", async () => {
    const res = await createGatewayRouter().request(
      "https://gw.example.com/gateways/gw-1/connections",
      { method: "GET" },
      makeEnv(),
    );

    expect(res.status).toBe(200);
    expect(captured).not.toBeNull();
    expect(captured!.headers.get("x-db-dsn")).toBeNull();
    expect(captured!.url).not.toContain("s3cr3t");
    expect(captured!.body).toBeNull();
  });
});
