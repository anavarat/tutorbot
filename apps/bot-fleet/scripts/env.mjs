// Literal .env loader — deliberately does NOT go through the shell, so values
// containing $, #, @ (like a Postgres password) are read verbatim. Shell
// `source`/`set -a` would expand `$AH` inside the password and corrupt it.
//
// One config file for every ops script: repo-root .local/cf.env (git-ignored).
import fs from "node:fs";

export function loadEnv(file = ".local/cf.env") {
  const txt = fs.readFileSync(file, "utf8");
  const env = {};
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i < 0) continue;
    const k = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    env[k] = v;
  }
  return env;
}

/**
 * Build the real Supabase connection string: if the URL's password is missing or a
 * dashboard placeholder ([YOUR-PASSWORD]), splice in SUPABASE_PASSWORD. The URL
 * setter percent-encodes it; node-postgres decodes it back. (SUPABASE_PASSOWRD is
 * tolerated as a legacy misspelling.)
 */
export function effectiveConnectionString(env = loadEnv()) {
  const raw = env.SUPABASE_CONN_STRING;
  if (!raw) throw new Error("SUPABASE_CONN_STRING missing in .local/cf.env");
  const u = new URL(raw);
  const pw = env.SUPABASE_PASSWORD ?? env.SUPABASE_PASSOWRD;
  const placeholder = /YOUR|\[|\]/i.test(decodeURIComponent(u.password || ""));
  if (pw && (placeholder || !u.password)) u.password = pw;
  return u.toString();
}

/** Redact the password for logging: scheme://user:****@host */
export function maskConn(s) {
  return s.replace(/:\/\/([^:@/]+):[^@/]+@/, "://$1:****@");
}
