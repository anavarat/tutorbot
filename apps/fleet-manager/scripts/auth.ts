/**
 * scripts/auth.ts — offline Telegram MTProto authentication (StringSession mint).
 *
 * WHY THIS EXISTS: an MTProto USER-ACCOUNT needs a one-time human OTP to log in.
 * A container has no stdin, so it can NEVER do the interactive login. This tool
 * runs ONCE per phone number on a human's machine, does the OTP dance, and prints
 * a StringSession — the serialized auth blob the container then consumes to
 * reconnect AS that account with no re-login (until the session is revoked).
 *
 * Adapted from fryan-tutorbot-tgram-proxy/scripts/auth.ts (the group-join / Worker
 * POST is dropped — DM-only scope; this tool only mints + prints the session).
 *
 * OWNERSHIP: minting/provisioning is a FleetManager responsibility (this tool is
 * the local stand-in for a GeeLark+Twilio identity pipeline); api_id/api_hash are
 * PER-BOT inputs (from my.telegram.org), not one shared app pair.
 *
 * Usage (from apps/fleet-manager):
 *   TELEGRAM_API_ID=<id> TELEGRAM_API_HASH=<hash> pnpm auth
 *   # or put them in apps/fleet-manager/.env  (git-ignored)
 *
 * Then feed the printed StringSession to POST /connection/connect
 * ({ botId, sessionCredential }). ⚠ The StringSession is FULL ACCOUNT ACCESS —
 * treat it like a password; never commit or log it.
 */

import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { TelegramClient, sessions } from "teleproto";
import { ConnectionTCPObfuscated } from "teleproto/network/connection/TCPObfuscated.js";

// ---------------------------------------------------------------------------
// Load creds from fleet-manager/.env (one level up from scripts/) then process.env
// ---------------------------------------------------------------------------
const __dirname = dirname(fileURLToPath(import.meta.url));

function loadEnvFile(path: string): Record<string, string> {
  try {
    const out: Record<string, string> = {};
    for (const line of readFileSync(path, "utf-8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      out[trimmed.slice(0, eq).trim()] = trimmed
        .slice(eq + 1)
        .trim()
        .replace(/^['"]|['"]$/g, "");
    }
    return out;
  } catch {
    return {};
  }
}

const fileEnv = loadEnvFile(resolve(__dirname, "../.env"));
// Shell env WINS over the .env file (standard precedence), and .trim() kills a
// stray space/newline in a pasted value — a dirty api_hash reads to Telegram as
// API_ID_INVALID, the exact trap this tool must not fall into.
const apiId = Number((process.env.TELEGRAM_API_ID ?? fileEnv.TELEGRAM_API_ID ?? "").trim());
const apiHash = (process.env.TELEGRAM_API_HASH ?? fileEnv.TELEGRAM_API_HASH ?? "").trim();

if (!apiId || !apiHash) {
  console.error("Error: TELEGRAM_API_ID and TELEGRAM_API_HASH must be set (env or container/.env)");
  process.exit(1);
}

// ---------------------------------------------------------------------------
const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = (q: string): Promise<string> => new Promise((res) => rl.question(q, res));

async function main(): Promise<void> {
  console.log("\n=== Telegram MTProto Authentication (StringSession mint) ===\n");
  console.log(`App ID:   ${apiId}`);
  console.log(`App Hash: ${apiHash.slice(0, 6)}… (len ${apiHash.length}, expect 32)\n`);

  const session = new sessions.StringSession("");
  const client = new TelegramClient(session, apiId, apiHash, {
    connectionRetries: 5,
    // Obfuscated transport bypasses DPI-based MTProto interference on restrictive
    // networks (default TCPFull is easily fingerprinted). Same as fryan's tool.
    connection: ConnectionTCPObfuscated,
  });

  await client.start({
    phoneNumber: async () => (await ask("Phone (with country code, e.g. +447700900000): ")).trim(),
    password: async () => await ask("2FA password (Enter if none): "),
    phoneCode: async () => (await ask("Verification code from Telegram: ")).trim(),
    onError: (err) => console.error("Auth error:", err.message),
  });

  const me = await client.getMe();
  const username = me && "username" in me ? (me as { username?: string }).username : "unknown";
  console.log(`\nAuthenticated as: @${username ?? "unknown"}`);

  const sessionString = (client.session as sessions.StringSession).save();
  console.log("\n--- StringSession (SECRET — full account access) ---");
  console.log(sessionString);
  console.log("----------------------------------------------------\n");
  console.log("Feed it to: POST /connection/connect  { botId, sessionCredential: <above> }\n");

  await client.disconnect();
  rl.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
