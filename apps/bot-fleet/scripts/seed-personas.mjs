// Persona seed — create the `persona` CATALOG table in Supabase and load a few
// teaching-tutor personas. `persona` is shared reference data (NO bot_id): many
// bots can point at the same persona. The reduced build's persona is tiny — just
// the voice the canned reply needs (name / subject / tone / greeting).
//
// Runs on YOUR machine (not the Worker), straight to Supabase over the direct
// pooler connection. Reads the repo-root .local/cf.env (SUPABASE_CONN_STRING +
// SUPABASE_PASSWORD) with a literal parser so the password's $ @ # survive.
//
//   node scripts/seed-personas.mjs            # DRY RUN: connect, show DDL + rows
//   node scripts/seed-personas.mjs --apply    # create table (if needed) + insert
import { fileURLToPath } from "node:url";
import pg from "pg";
import { loadEnv } from "./env.mjs";
const { Client } = pg;

const APPLY = process.argv.includes("--apply");

// .local/cf.env lives at the REPO ROOT, three levels up from apps/bot-fleet/scripts/.
const CF_ENV_PATH = fileURLToPath(new URL("../../../.local/cf.env", import.meta.url));

function resolveClientConfig() {
  const env = loadEnv(CF_ENV_PATH);
  const conn = env.SUPABASE_CONN_STRING;
  const password = env.SUPABASE_PASSWORD ?? env.SUPABASE_PASSOWRD; // tolerate the legacy misspelling
  if (!conn) throw new Error("SUPABASE_CONN_STRING missing in .local/cf.env");
  if (!password) throw new Error("SUPABASE_PASSWORD missing in .local/cf.env");

  const m = conn.match(/^postgres(?:ql)?:\/\/([^:@/]+):[^@]*@([^:/]+):(\d+)\/(.+)$/);
  if (!m) throw new Error("SUPABASE_CONN_STRING not in expected user:pass@host:port/db form");
  const [, user, host, port, database] = m;
  return { host, port: Number(port), user, password, database, ssl: { rejectUnauthorized: false } };
}

function maskCfg(cfg) {
  return `postgresql://${cfg.user}:****@${cfg.host}:${cfg.port}/${cfg.database}`;
}

// Idempotent DDL. Shared catalog: no bot_id. Reduced persona shape.
const CREATE_DDL = `
CREATE TABLE IF NOT EXISTS persona (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL UNIQUE,
  subject    TEXT NOT NULL,
  tone       TEXT NOT NULL,
  greeting   TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

// Teaching personas — placeholder tutors. Each is just a voice for the canned reply.
const PERSONAS = [
  { name: "Ada",  subject: "Mathematics", tone: "warm and encouraging",     greeting: "Hi there!" },
  { name: "Leo",  subject: "History",     tone: "curious and story-driven",  greeting: "Hello!" },
  { name: "Mira", subject: "Science",     tone: "playful and precise",       greeting: "Hey!" },
  { name: "Ravi", subject: "Programming", tone: "patient and example-first", greeting: "Namaste!" },
];

const INSERT_SQL =
  "INSERT INTO persona (name, subject, tone, greeting) VALUES ($1, $2, $3, $4) ON CONFLICT (name) DO NOTHING";

async function personaCount(client) {
  try {
    const { rows } = await client.query("SELECT count(*)::int AS n FROM persona");
    return rows[0].n;
  } catch {
    return "(table does not exist yet)";
  }
}

async function main() {
  const cfg = resolveClientConfig();
  const client = new Client(cfg);
  await client.connect();
  console.log("connected:", maskCfg(cfg));
  console.log("mode:     ", APPLY ? "APPLY (create table if needed + insert)" : "DRY RUN (no changes)");
  console.log("\npersona rows before:", await personaCount(client));

  if (!APPLY) {
    console.log("\n--- CREATE DDL (not executed) ---");
    console.log(CREATE_DDL.trim());
    console.log("\n--- rows that WOULD be seeded ---");
    console.table(PERSONAS);
    console.log("\nDry run only. Re-run with --apply to execute.");
    await client.end();
    return;
  }

  await client.query("BEGIN");
  try {
    await client.query(CREATE_DDL);
    for (const p of PERSONAS) {
      const res = await client.query(INSERT_SQL, [p.name, p.subject, p.tone, p.greeting]);
      console.log(`  ${res.rowCount === 1 ? "inserted" : "skipped (exists)"}: ${p.name}`);
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  }

  console.log("\npersona rows after:", await personaCount(client));
  await client.end();
}

main().catch((err) => {
  console.error("seed failed:", err.message);
  process.exit(1);
});
