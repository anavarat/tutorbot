import { Client } from "pg";

/**
 * List the display names of all personas in the catalog, sorted. Backs the
 * fleet-manager persona picker (GET /personas -> UI): FM reads the catalog
 * DIRECTLY from Supabase over its own HYPERDRIVE binding, rather than proxying
 * bot-fleet's old /personas route. bot-fleet keeps `getPersonaByName` (reply-loop
 * hydration); this is only the name list for the picker.
 *
 * Mirrors bot-fleet's message-repo / persona-repo: a throwaway pg `Client`, and it
 * NEVER THROWS — a DB blip returns [] so the picker is momentarily empty instead of
 * 500ing (provisioning still works; personaName is optional + free-typed).
 */
export async function listPersonaNames(connectionString: string): Promise<string[]> {
  const client = new Client({ connectionString });
  try {
    await client.connect();
    const res = await client.query("SELECT name FROM persona ORDER BY name ASC");
    return res.rows.map((r) => String(r.name));
  } catch {
    return [];
  } finally {
    try {
      await client.end();
    } catch {
      /* ignore teardown errors */
    }
  }
}
