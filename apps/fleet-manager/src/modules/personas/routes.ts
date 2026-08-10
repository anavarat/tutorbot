import { Hono } from "hono";
import type { AppEnv } from "../../types";
import { fail } from "../../lib/http";
import { listPersonaNames } from "../../platform/hyperdrive/persona-repo";

/**
 * /personas router (mounted at "/personas"). Returns the persona-catalog name
 * list so an operator/UI can pick a persona before calling POST /bots. FM reads
 * the catalog DIRECTLY from Supabase via its HYPERDRIVE binding (listPersonaNames);
 * it no longer proxies bot-fleet. Never 500s on a DB blip: listPersonaNames returns
 * [] and the picker is momentarily empty (provisioning still works).
 */
export const personasRoutes = new Hono<AppEnv>();

personasRoutes.get("/", async (c) => {
  const personas = await listPersonaNames(c.env.HYPERDRIVE.connectionString);
  return c.json({ ok: true, personas }, 200);
});

personasRoutes.all("/", (c) => fail(c, 405, "method not allowed"));
