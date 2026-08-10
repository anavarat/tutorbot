import { describe, expect, it } from "vitest";

import { toRecoveryBots } from "./controller";
import type { BotRow } from "../../platform/persistence/bots-dao";

/** Build a BotRow with only the fields toRecoveryBots reads; rest are filler. */
function row(p: Partial<BotRow>): BotRow {
  return {
    bot_id: "b1",
    gateway_id: "gw-1",
    persona_name: null,
    api_id: 123,
    api_hash: "secret-hash",
    phone: null,
    session_credential: "sess-cred",
    status: "running",
    created_at: 1000,
    updated_at: 1000,
    reassign_target_gw: null,
    reassign_state: null,
    reassign_started_at: null,
    ...p,
  } as BotRow;
}

describe("toRecoveryBots (recovery roster shaper)", () => {
  it("maps a full row to the minimal recovery credential", () => {
    const out = toRecoveryBots([row({ bot_id: "b1", api_id: 111, session_credential: "S1" })]);
    expect(out).toEqual([{ botId: "b1", apiId: 111, sessionCredential: "S1" }]);
  });

  it("NEVER emits api_hash (reconnect never reads it; placeholder used in-container)", () => {
    const out = toRecoveryBots([row({ api_hash: "super-secret" })]);
    expect(JSON.stringify(out)).not.toContain("super-secret");
    expect(out[0]).not.toHaveProperty("apiHash");
    expect(out[0]).not.toHaveProperty("api_hash");
  });

  it("skips bots missing api_id (nothing to recover)", () => {
    const out = toRecoveryBots([row({ bot_id: "b1", api_id: null })]);
    expect(out).toEqual([]);
  });

  it("skips bots missing session_credential (nothing to recover)", () => {
    const out = toRecoveryBots([row({ bot_id: "b1", session_credential: null })]);
    expect(out).toEqual([]);
  });

  it("keeps only the recoverable subset from a mixed list, preserving order", () => {
    const out = toRecoveryBots([
      row({ bot_id: "ok1", api_id: 1, session_credential: "s1" }),
      row({ bot_id: "no-cred", session_credential: null }),
      row({ bot_id: "no-api", api_id: null }),
      row({ bot_id: "ok2", api_id: 2, session_credential: "s2" }),
    ]);
    expect(out).toEqual([
      { botId: "ok1", apiId: 1, sessionCredential: "s1" },
      { botId: "ok2", apiId: 2, sessionCredential: "s2" },
    ]);
  });
});
