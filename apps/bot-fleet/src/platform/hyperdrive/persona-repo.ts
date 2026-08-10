import { Client } from "pg";
import type { PersonaPrompt } from "../../domain/reply/persona";

/**
 * PERSONA hydrate. One Hyperdrive->Postgres read of a single `persona` catalog
 * row by its unique display name, mapped snake_case -> camelCase into
 * `PersonaPrompt`. Called ONCE per run from `BotFleetDO.start()` (persona is
 * static catalog data, cached in RunState for the whole run) — NOT per wake.
 *
 * NEVER THROWS: a miss or any DB error returns `null` so the caller falls back to
 * the generic tutor voice, never blocking the poll loop.
 */
export async function getPersonaByName(
  connectionString: string,
  name: string,
): Promise<PersonaPrompt | null> {
  const client = new Client({ connectionString });
  try {
    await client.connect();
    const res = await client.query(
      "SELECT name, subject, tone, greeting FROM persona WHERE name = $1",
      [name],
    );
    const r = res.rows[0];
    if (!r) return null; // unknown persona name -> caller uses fallback voice
    return {
      name: String(r.name),
      subject: String(r.subject),
      tone: String(r.tone),
      greeting: String(r.greeting),
    };
  } catch {
    return null;
  } finally {
    try {
      await client.end();
    } catch {
      /* ignore teardown errors */
    }
  }
}
