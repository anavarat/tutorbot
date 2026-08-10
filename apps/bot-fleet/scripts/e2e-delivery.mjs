// E2E helper for the effectively-once DELIVERY test (unified Step-1 schema).
// Runs on YOUR machine, straight to Supabase over the direct pooler. Reads creds
// from .local/cf.env with a literal parser (never through the shell).
//
//   node scripts/e2e-delivery.mjs seed   <bot> [chatId]  # insert 1 inbound (chat+message, from_me=false)
//   node scripts/e2e-delivery.mjs verify <bot>           # recent message rows: from_me + channel_message_id
//   node scripts/e2e-delivery.mjs undelivered <bot>      # from_me=true AND channel_message_id IS NULL
// node scripts/e2e-delivery.mjs state <bot> # outbox: delivery_state/attempts/next_attempt_at/last_error
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Client } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CF_ENV = process.env.CF_ENV_FILE ?? path.resolve(__dirname, "../../../.local/cf.env");

function loadEnv(file) {
  const txt = fs.readFileSync(file, "utf8");
  const env = {};
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i < 0) continue;
    const k = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    env[k] = v;
  }
  return env;
}

function effectiveConnectionString() {
  const env = loadEnv(CF_ENV);
  const raw = env.SUPABASE_CONN_STRING;
  if (!raw) throw new Error(`SUPABASE_CONN_STRING missing in ${CF_ENV}`);
  const u = new URL(raw);
  const pw = env.SUPABASE_PASSWORD ?? env.SUPABASE_PASSOWRD;
  const placeholder = /YOUR|\[|\]/i.test(decodeURIComponent(u.password || ""));
  if (pw && (placeholder || !u.password)) u.password = pw;
  return u.toString();
}

const mask = (s) => s.replace(/:\/\/([^:@/]+):[^@/]+@/, "://$1:****@");

async function withClient(fn) {
  const client = new Client({ connectionString: effectiveConnectionString(), ssl: { rejectUnauthorized: false } });
  await client.connect();
  console.log("connected:", mask(effectiveConnectionString()));
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => {});
  }
}

async function seed(client, bot, chatId) {
  const channel = "telegram";
  const channelChatId = chatId || "dm:e2e";
  const channelMessageId = `${Date.now()}`;
  const idem = `${channel}:${channelChatId}:${channelMessageId}`;
  const chatRes = await client.query(
    `INSERT INTO chat (bot_id, channel, channel_chat_id, is_group, name, last_message_at)
     VALUES ($1,$2,$3,false,$4,now())
     ON CONFLICT (bot_id, channel, channel_chat_id) DO UPDATE SET last_message_at = now()
     RETURNING id::text AS id`,
    [bot, channel, channelChatId, `e2e ${bot}`],
  );
  const chatId2 = chatRes.rows[0].id;
  const msg = await client.query(
    `INSERT INTO message (bot_id, chat_id, channel_message_id, idempotency_key, from_me, content)
     VALUES ($1,$2,$3,$4,false,$5)
     ON CONFLICT (bot_id, idempotency_key) DO NOTHING
     RETURNING id::text AS id`,
    [bot, chatId2, channelMessageId, idem, "Hey, are you around? Is that account still active?"],
  );
  console.log(`seeded inbound for ${bot}: chatId=${chatId2} messageId=${msg.rows[0]?.id ?? "(dup)"} idem=${idem}`);
}

async function verify(client, bot) {
  const r = await client.query(
    `SELECT id, from_me, channel_message_id, idempotency_key, left(content,42) AS content
       FROM message WHERE bot_id=$1 ORDER BY id DESC LIMIT 10`,
    [bot],
  );
  console.log(`recent message rows for ${bot} (newest first):`);
  for (const x of r.rows) {
    console.log(
      `  id=${x.id} from_me=${x.from_me} channel_message_id=${x.channel_message_id ?? "NULL"} idem=${x.idempotency_key} | ${JSON.stringify(x.content)}`,
    );
  }
}

async function undelivered(client, bot) {
  const r = await client.query(
    `SELECT id, idempotency_key, left(content,42) AS content
       FROM message WHERE bot_id=$1 AND from_me=true AND channel_message_id IS NULL ORDER BY id ASC`,
    [bot],
  );
  console.log(`undelivered (from_me=true, channel_message_id NULL) for ${bot}: ${r.rows.length} rows`);
  for (const x of r.rows) console.log(`  id=${x.id} idem=${x.idempotency_key} | ${JSON.stringify(x.content)}`);
}

// outbox work-queue view: the state machine columns for a bot's OUTBOUND
// rows (from_me=true). Lets you watch a reply move PENDING -> (retry: attempts++,
// next_attempt_at pushed out) -> SENT, or land in DLQ. channel_message_id NOT
// NULL == the gateway stamped it delivered.
async function state(client, bot) {
  const r = await client.query(
    `SELECT id, delivery_state, attempts,
            to_char(next_attempt_at, 'HH24:MI:SS') AS next_at,
            channel_message_id,
            left(last_error, 44) AS last_error
       FROM message
      WHERE bot_id=$1 AND from_me=true
      ORDER BY id DESC LIMIT 12`,
    [bot],
  );
  console.log(`outbox state for ${bot} (newest first):`);
  console.table(r.rows);
}

async function main() {
  const cmd = process.argv[2] ?? "verify";
  const bot = process.argv[3] ?? "bot-1";
  await withClient(async (client) => {
    if (cmd === "seed") return seed(client, bot, process.argv[4]);
    if (cmd === "verify") return verify(client, bot);
    if (cmd === "undelivered") return undelivered(client, bot);
    if (cmd === "state") return state(client, bot);
    throw new Error(`unknown command: ${cmd}`);
  });
}

main().catch((e) => {
  console.error("e2e helper failed:", e.message);
  process.exit(1);
});
