import { DB_DSN_FIELD } from "@tutorbot/shared";
import { describe, expect, it } from "vitest";

import {
  buildConnectBody,
  deleteSession,
  listSessions,
  parseSession,
  persistSession,
  PLACEHOLDER_API_HASH,
  sessionKey,
  type SessionStorage,
  type StoredSession,
} from "./session-store.js";

/** Map-backed fake of the DO storage subset (no workers runtime needed). */
function fakeStorage(): SessionStorage & { map: Map<string, StoredSession> } {
  const map = new Map<string, StoredSession>();
  return {
    map,
    async put(key, value) {
      map.set(key, value);
    },
    async list({ prefix }) {
      const out = new Map<string, StoredSession>();
      for (const [k, v] of map) if (k.startsWith(prefix)) out.set(k, v);
      return out;
    },
    async delete(key) {
      return map.delete(key);
    },
  };
}

describe("session-store", () => {
  it("persists ONLY {apiId, sessionCredential} under the namespaced key", async () => {
    const st = fakeStorage();
    await persistSession(st, { botId: "bot-1", apiId: 123, sessionCredential: "1AaSess==" });
    expect(st.map.get(sessionKey("bot-1"))).toEqual({ apiId: 123, sessionCredential: "1AaSess==" });
    // No api_hash / dsn / phone leaked into storage.
    expect(Object.keys(st.map.get("session:bot-1")!)).toEqual(["apiId", "sessionCredential"]);
  });

  it("lists sessions back with the botId recovered from the key", async () => {
    const st = fakeStorage();
    await persistSession(st, { botId: "bot-1", apiId: 1, sessionCredential: "a" });
    await persistSession(st, { botId: "bot-2", apiId: 2, sessionCredential: "b" });
    const got = await listSessions(st);
    expect(got).toContainEqual({ botId: "bot-1", apiId: 1, sessionCredential: "a" });
    expect(got).toContainEqual({ botId: "bot-2", apiId: 2, sessionCredential: "b" });
    expect(got).toHaveLength(2);
  });

  it("deleteSession removes one bot's record", async () => {
    const st = fakeStorage();
    await persistSession(st, { botId: "bot-1", apiId: 1, sessionCredential: "a" });
    expect(await deleteSession(st, "bot-1")).toBe(true);
    expect(await listSessions(st)).toHaveLength(0);
  });

  it("parseSession accepts a valid connect body, rejects incomplete ones", () => {
    expect(parseSession({ botId: "bot-1", apiId: 5, sessionCredential: "s" })).toEqual({
      botId: "bot-1",
      apiId: 5,
      sessionCredential: "s",
    });
    expect(parseSession({ botId: "bot-1", sessionCredential: "s" })).toBeNull(); // no apiId
    expect(parseSession({ apiId: 5, sessionCredential: "s" })).toBeNull(); // no botId
    expect(parseSession({ botId: "bot-1", apiId: 5 })).toBeNull(); // no session
    expect(parseSession(null)).toBeNull();
  });

  it("buildConnectBody injects the placeholder hash + DSN, never the real hash", () => {
    const body = buildConnectBody({ botId: "bot-1", apiId: 9, sessionCredential: "sc" }, "postgres://dsn");
    expect(body).toEqual({
      botId: "bot-1",
      apiId: 9,
      apiHash: PLACEHOLDER_API_HASH,
      sessionCredential: "sc",
      [DB_DSN_FIELD]: "postgres://dsn",
    });
  });
});
