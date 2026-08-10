import { describe, expect, it } from "vitest";

import { createControlRouter } from "./control-routes";

/** A fake per-bot DO stub; each method records its call and returns a canned result.
 *  Any method can be overridden (e.g. to throw) per test. */
function fakeEnv(stubOverrides: Record<string, unknown> = {}) {
  const calls: Array<[string, unknown?]> = [];
  const stub = {
    start: async (opts: unknown) => {
      calls.push(["start", opts]);
      return { ok: true, botId: (opts as { botId: string }).botId, startedAt: 1 };
    },
    reconfigure: async (opts: unknown) => {
      calls.push(["reconfigure", opts]);
      return { ok: true, gatewayId: (opts as { gatewayId: string }).gatewayId };
    },
    stop: async () => {
      calls.push(["stop"]);
      return { ok: true, botId: "bot-1", count: 3 };
    },
    stats: async () => {
      calls.push(["stats"]);
      return { botId: "bot-1", count: 3, cursor: 0, rowsTotal: 0, runMinutes: 0 };
    },
    ...stubOverrides,
  };
  const env = {
    BOT_FLEET_DO: {
      getByName: (id: string) => {
        calls.push(["getByName", id]);
        return stub;
      },
    },
  } as unknown as Parameters<ReturnType<typeof createControlRouter>["request"]>[2];
  return { env, calls };
}

const JSON_POST = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

describe("bot-fleet control routes", () => {
  it("POST /bots/:id/start resolves the DO by name and forwards the opts", async () => {
    const { env, calls } = fakeEnv();
    const res = await createControlRouter().request(
      "/bots/bot-1/start",
      JSON_POST({ gatewayId: "gw-1", personaName: "Tanya", runMinutes: 90 }),
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, botId: "bot-1", startedAt: 1 });
    expect(calls).toContainEqual(["getByName", "bot-1"]);
    // botId comes from the path; the rest from the body.
    expect(calls).toContainEqual([
      "start",
      { botId: "bot-1", gatewayId: "gw-1", personaName: "Tanya", runMinutes: 90, force: undefined },
    ]);
  });

  it("POST /bots/:id/start rejects a missing gatewayId with 400 (no DO call)", async () => {
    const { env, calls } = fakeEnv();
    const res = await createControlRouter().request("/bots/bot-1/start", JSON_POST({}), env);
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("POST /bots/:id/reconfigure forwards the gatewayId", async () => {
    const { env, calls } = fakeEnv();
    const res = await createControlRouter().request(
      "/bots/bot-1/reconfigure",
      JSON_POST({ gatewayId: "gw-2" }),
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, gatewayId: "gw-2" });
    expect(calls).toContainEqual(["reconfigure", { gatewayId: "gw-2" }]);
  });

  it("POST /bots/:id/stop returns the stop result", async () => {
    const { env } = fakeEnv();
    const res = await createControlRouter().request("/bots/bot-1/stop", { method: "POST" }, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, botId: "bot-1", count: 3 });
  });

  it("GET /bots/:id/stats returns the counters", async () => {
    const { env } = fakeEnv();
    const res = await createControlRouter().request("/bots/bot-1/stats", { method: "GET" }, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ botId: "bot-1", count: 3 });
  });

  it("maps a thrown DO error to 500 (so the caller treats it as an infra failure)", async () => {
    const { env } = fakeEnv({
      start: async () => {
        throw new Error("do exploded");
      },
    });
    const res = await createControlRouter().request(
      "/bots/bot-1/start",
      JSON_POST({ gatewayId: "gw-1" }),
      env,
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ ok: false, error: "do exploded" });
  });

  it("returns a business ok:false outcome as a 200 (not an error)", async () => {
    const { env } = fakeEnv({
      reconfigure: async () => ({ ok: false, reason: "not running" }),
    });
    const res = await createControlRouter().request(
      "/bots/bot-1/reconfigure",
      JSON_POST({ gatewayId: "gw-2" }),
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, reason: "not running" });
  });
});
