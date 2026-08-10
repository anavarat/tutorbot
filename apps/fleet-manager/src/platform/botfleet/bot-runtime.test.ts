import { describe, expect, it } from "vitest";

import { HttpBotRuntime } from "./bot-runtime";
import type { FleetEnv } from "../../types";

/** A fake BOT_FLEET service binding that records the request and returns a canned
 *  Response. `respond` builds the Response from the (already-read) request info. */
function fakeBinding(respond: (info: { url: string; method: string; body: unknown }) => Response) {
  const requests: Array<{ url: string; method: string; body: unknown }> = [];
  const bf = {
    async fetch(req: Request): Promise<Response> {
      const body = req.method === "GET" ? undefined : await req.clone().json().catch(() => undefined);
      const info = { url: req.url, method: req.method, body };
      requests.push(info);
      return respond(info);
    },
  } as unknown as FleetEnv["BOT_FLEET"];
  return { bf, requests };
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

describe("HttpBotRuntime", () => {
  it("start posts to /bots/:id/start with the opts and returns the parsed result", async () => {
    const { bf, requests } = fakeBinding(() => json({ ok: true, botId: "bot-1", startedAt: 9 }));
    const rt = new HttpBotRuntime(bf);
    const res = await rt.start("bot-1", { gatewayId: "gw-1", personaName: "Tanya" });
    expect(res).toEqual({ ok: true, botId: "bot-1", startedAt: 9 });
    expect(requests[0].method).toBe("POST");
    expect(requests[0].url).toBe("https://bot-fleet/bots/bot-1/start");
    expect(requests[0].body).toEqual({ gatewayId: "gw-1", personaName: "Tanya" });
  });

  it("reconfigure posts to /bots/:id/reconfigure and returns a business ok:false as a value (not a throw)", async () => {
    const { bf, requests } = fakeBinding(() => json({ ok: false, reason: "not running" }));
    const rt = new HttpBotRuntime(bf);
    const res = await rt.reconfigure("bot-1", { gatewayId: "gw-2" });
    expect(res).toEqual({ ok: false, reason: "not running" });
    expect(requests[0].url).toBe("https://bot-fleet/bots/bot-1/reconfigure");
    expect(requests[0].body).toEqual({ gatewayId: "gw-2" });
  });

  it("stats does a GET and returns the counters", async () => {
    const { bf, requests } = fakeBinding(() => json({ botId: "bot-1", count: 5 }));
    const rt = new HttpBotRuntime(bf);
    const res = await rt.stats("bot-1");
    expect(res).toMatchObject({ botId: "bot-1", count: 5 });
    expect(requests[0].method).toBe("GET");
    expect(requests[0].url).toBe("https://bot-fleet/bots/bot-1/stats");
  });

  it("THROWS on a non-2xx (infra failure) so BotService maps it to do_error", async () => {
    const { bf } = fakeBinding(() => json({ ok: false, error: "do exploded" }, 500));
    const rt = new HttpBotRuntime(bf);
    await expect(rt.start("bot-1", { gatewayId: "gw-1" })).rejects.toThrow("do exploded");
  });

  it("THROWS when the BOT_FLEET binding is not configured", async () => {
    const rt = new HttpBotRuntime(undefined);
    await expect(rt.stop("bot-1")).rejects.toThrow("BOT_FLEET service binding not configured");
  });

  it("url-encodes the botId", async () => {
    const { bf, requests } = fakeBinding(() => json({ ok: true, botId: "a/b", count: 0 }));
    const rt = new HttpBotRuntime(bf);
    await rt.stop("a/b");
    expect(requests[0].url).toBe("https://bot-fleet/bots/a%2Fb/stop");
  });
});
