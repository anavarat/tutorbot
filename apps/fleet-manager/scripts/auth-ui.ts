/**
 * scripts/auth-ui.ts — LOCAL browser UI for minting a Telegram StringSession.
 *
 * Same job as scripts/auth.ts, but a 2-step web form instead of terminal prompts.
 *
 * WHY A LOCAL SERVER (not a CF endpoint): MTProto login is STATEFUL — phone →
 * code → 2FA all run on ONE live `TelegramClient` whose `client.start()` holds the
 * connection open across steps and blocks in callbacks waiting for input. So the
 * backend must keep the client in memory between "submit phone" and "submit code".
 * This is an OPERATOR tool: it logs into a real account and the resulting
 * StringSession is FULL ACCOUNT ACCESS, so it binds to 127.0.0.1 only and is NEVER
 * deployed. It lives in the fm app outside src/ (never bundled), run via `pnpm auth:ui`.
 *
 * Flow (promise-bridge): POST /api/start kicks off client.start() and parks the
 * `phoneCode`/`password` callbacks on deferreds; it responds only once Telegram has
 * actually SENT the code (the phoneCode callback fired). POST /api/finish resolves
 * those deferreds with the browser's input, awaits start(), then getMe + save().
 */

import { randomUUID } from "node:crypto";

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { TelegramClient, sessions } from "teleproto";
import { ConnectionTCPObfuscated } from "teleproto/network/connection/TCPObfuscated.js";

const HOST = "127.0.0.1";
const PORT = Number(process.env.AUTH_UI_PORT ?? 8788);

interface Flow {
  client: TelegramClient;
  resolveCode?: (code: string) => void;
  resolvePassword?: (pw: string) => void;
  startPromise: Promise<void>;
  error?: string;
}

// Single-operator, ephemeral: one process, a handful of in-flight logins keyed by id.
const flows = new Map<string, Flow>();

const app = new Hono();

app.get("/", (c) => c.html(PAGE));

/** Step 1: connect + send the code. Resolves once the code is on its way. */
app.post("/api/start", async (c) => {
  const body = (await c.req.json().catch(() => null)) as
    | { apiId?: unknown; apiHash?: unknown; phone?: unknown }
    | null;

  const apiId = Number(String(body?.apiId ?? "").trim());
  const apiHash = String(body?.apiHash ?? "").trim();
  const phone = String(body?.phone ?? "").trim();
  if (!apiId || !apiHash || !phone) {
    return c.json({ ok: false, error: "apiId, apiHash and phone are required" }, 400);
  }

  const flowId = randomUUID();
  const client = new TelegramClient(new sessions.StringSession(""), apiId, apiHash, {
    connectionRetries: 5,
    connection: ConnectionTCPObfuscated,
  });

  let resolveCode!: (code: string) => void;
  let resolvePassword!: (pw: string) => void;
  const codePromise = new Promise<string>((res) => (resolveCode = res));
  const passwordPromise = new Promise<string>((res) => (resolvePassword = res));

  // Signals that Telegram sent the code (the phoneCode callback was entered), so
  // /api/start can respond and the browser can show the code step.
  let signalCodeSent!: () => void;
  const codeSent = new Promise<void>((res) => (signalCodeSent = res));

  const flow: Flow = {
    client,
    resolveCode,
    resolvePassword,
    startPromise: Promise.resolve(),
  };
  flows.set(flowId, flow);

  flow.startPromise = client
    .start({
      phoneNumber: async () => phone,
      phoneCode: async () => {
        signalCodeSent();
        return await codePromise;
      },
      password: async () => await passwordPromise, // only called if 2FA is enabled
      onError: (e: Error) => {
        flow.error = e.message;
        return true; // stop the auth loop; surface the error instead of re-prompting
      },
    })
    .catch((e: unknown) => {
      flow.error = e instanceof Error ? e.message : String(e);
      throw e;
    });

  // Wait until the code is sent, OR start() failed early (e.g. API_ID_INVALID).
  await Promise.race([codeSent, flow.startPromise.catch(() => {})]);
  if (flow.error) {
    await client.disconnect().catch(() => {});
    flows.delete(flowId);
    return c.json({ ok: false, error: flow.error }, 400);
  }
  return c.json({ ok: true, flowId });
});

/** Step 2: submit code (+ optional 2FA password) → finish sign-in → StringSession. */
app.post("/api/finish", async (c) => {
  const body = (await c.req.json().catch(() => null)) as
    | { flowId?: unknown; code?: unknown; password?: unknown }
    | null;
  const flow = flows.get(String(body?.flowId ?? ""));
  if (!flow) {
    return c.json({ ok: false, error: "unknown or expired login flow — start over" }, 404);
  }

  flow.resolveCode?.(String(body?.code ?? "").trim());
  flow.resolvePassword?.(String(body?.password ?? ""));

  try {
    await flow.startPromise; // consumes the code (and password iff 2FA) → signs in
    const me = (await flow.client.getMe()) as { id?: unknown; username?: unknown } | null;
    const sessionCredential = (flow.client.session as sessions.StringSession).save();
    await flow.client.disconnect().catch(() => {});
    return c.json({
      ok: true,
      sessionCredential,
      identity: {
        id: me?.id != null ? String(me.id) : "",
        username: typeof me?.username === "string" ? me.username : null,
      },
    });
  } catch (e: unknown) {
    await flow.client.disconnect().catch(() => {});
    return c.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      400,
    );
  } finally {
    flows.delete(String(body?.flowId ?? ""));
  }
});

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Telegram StringSession mint</title>
<style>
  body{font:15px/1.5 system-ui,sans-serif;max-width:640px;margin:40px auto;padding:0 16px;color:#111}
  h1{font-size:20px} label{display:block;margin:12px 0 4px;font-weight:600}
  input{width:100%;padding:9px 10px;border:1px solid #bbb;border-radius:8px;font:inherit;box-sizing:border-box}
  button{margin-top:16px;padding:10px 16px;border:0;border-radius:8px;background:#0088cc;color:#fff;font:inherit;font-weight:600;cursor:pointer}
  button:disabled{opacity:.5;cursor:default}
  .card{border:1px solid #e2e2e2;border-radius:12px;padding:20px;margin-top:20px}
  .hint{color:#666;font-size:13px} .err{color:#c00;margin-top:12px;white-space:pre-wrap}
  .ok{color:#080} textarea{width:100%;height:110px;font:13px monospace;padding:10px;border:1px solid #bbb;border-radius:8px;box-sizing:border-box}
  .warn{background:#fff8e1;border:1px solid #ffe082;border-radius:8px;padding:10px;font-size:13px;margin-top:12px}
  .hidden{display:none}
</style></head><body>
<h1>Telegram StringSession mint</h1>
<p class="hint">Local operator tool. The resulting session is <b>full account access</b> — treat it like a password.</p>

<div class="card" id="step1">
  <label>api_id</label><input id="apiId" placeholder="123456">
  <label>api_hash</label><input id="apiHash" placeholder="32 hex chars">
  <label>Phone (with country code)</label><input id="phone" placeholder="+447700900000">
  <button id="startBtn">Send code</button>
  <div class="err" id="err1"></div>
</div>

<div class="card hidden" id="step2">
  <p>Telegram sent a login code to your app. Enter it below.</p>
  <label>Login code</label><input id="code" placeholder="12345" inputmode="numeric">
  <label>2FA password <span class="hint">(only if you set one; leave blank otherwise)</span></label>
  <input id="password" type="password" placeholder="">
  <button id="finishBtn">Sign in</button>
  <div class="err" id="err2"></div>
</div>

<div class="card hidden" id="done">
  <p class="ok"><b>Authenticated</b> as <span id="who"></span></p>
  <label>StringSession (sessionCredential)</label>
  <textarea id="session" readonly></textarea>
  <button id="copyBtn">Copy</button>
  <div class="warn">Feed this to <code>POST /connection/connect</code> as <code>sessionCredential</code>. Secret — do not commit or paste in chat.</div>
</div>

<script>
let flowId = null;
const $ = (id) => document.getElementById(id);
async function post(url, body){
  const r = await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  return r.json();
}
$('startBtn').onclick = async () => {
  $('err1').textContent=''; $('startBtn').disabled=true; $('startBtn').textContent='Sending…';
  try{
    const res = await post('/api/start',{apiId:$('apiId').value,apiHash:$('apiHash').value,phone:$('phone').value});
    if(!res.ok){ $('err1').textContent=res.error; return; }
    flowId=res.flowId; $('step1').classList.add('hidden'); $('step2').classList.remove('hidden');
  }catch(e){ $('err1').textContent=String(e); }
  finally{ $('startBtn').disabled=false; $('startBtn').textContent='Send code'; }
};
$('finishBtn').onclick = async () => {
  $('err2').textContent=''; $('finishBtn').disabled=true; $('finishBtn').textContent='Signing in…';
  try{
    const res = await post('/api/finish',{flowId,code:$('code').value,password:$('password').value});
    if(!res.ok){ $('err2').textContent=res.error+'\\n(if the code was wrong, reload and start over)'; return; }
    $('step2').classList.add('hidden'); $('done').classList.remove('hidden');
    $('who').textContent = res.identity.username ? ('@'+res.identity.username) : ('id '+res.identity.id);
    $('session').value = res.sessionCredential;
  }catch(e){ $('err2').textContent=String(e); }
  finally{ $('finishBtn').disabled=false; $('finishBtn').textContent='Sign in'; }
};
$('copyBtn').onclick = () => { $('session').select(); document.execCommand('copy'); $('copyBtn').textContent='Copied'; };
</script>
</body></html>`;

serve({ fetch: app.fetch, hostname: HOST, port: PORT }, () => {
  console.log(`\n  Telegram auth UI → http://${HOST}:${PORT}\n  (local only; Ctrl+C to stop)\n`);
});
