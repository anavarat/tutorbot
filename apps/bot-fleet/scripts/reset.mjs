// Clean slate — DELETE rows for the bots so each run starts from cursor 0 and the
// counters reflect exactly what happens during the run.
//
// Runs on YOUR machine (not the Worker), straight to Supabase over the DIRECT
// pooler connection (reads .local/cf.env). Run this right before launch:
//
//   node scripts/reset.mjs           # bot-1..bot-3 (default)
//   node scripts/reset.mjs 5         # bot-1..bot-5
//
// Schema ownership: the unified `chat` + `message` (+ `gateway_update_state`)
// tables are created by the gateway container's boot-guard (see
// packages/shared/src/schema.ts). This script only DELETES; it tolerates a table
// that does not exist yet (fresh DB) instead of recreating a drifting copy.
import pg from "pg";
import { effectiveConnectionString, maskConn } from "./env.mjs";
const { Client } = pg;

const COUNT = Number(process.argv[2]) > 0 ? Math.floor(Number(process.argv[2])) : 3;
const BOTS = Array.from({ length: COUNT }, (_, i) => `bot-${i + 1}`);

const connectionString = effectiveConnectionString();
const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });

/** DELETE, but ignore "relation does not exist" (42P01) on a fresh database. */
async function clear(table, sql, params) {
  try {
    const res = await client.query(sql, params);
    console.log(`cleared ${res.rowCount ?? 0} rows from ${table}`);
  } catch (err) {
    if (err.code === "42P01") {
      console.log(`skipped ${table} (table does not exist yet)`);
    } else {
      throw err;
    }
  }
}

async function main() {
  await client.connect();
  console.log("connected:", maskConn(connectionString));

  // `message.chat_id REFERENCES chat(id) ON DELETE CASCADE`, so deleting chat rows
  // cascades their messages; we also delete message + the MTProto cursor directly
  // to catch any orphans and reset catch-up.
  await clear("chat", "DELETE FROM chat WHERE bot_id = ANY($1)", [BOTS]);
  await clear("message", "DELETE FROM message WHERE bot_id = ANY($1)", [BOTS]);
  await clear("gateway_update_state", "DELETE FROM gateway_update_state WHERE bot_id = ANY($1)", [BOTS]);

  console.log(`reset complete for ${BOTS.join(", ")} — DO cursors will start at 0.`);
}

main()
  .then(() => client.end())
  .catch((err) => {
    console.error("reset failed:", err.message);
    return client.end().finally(() => process.exit(1));
  });
