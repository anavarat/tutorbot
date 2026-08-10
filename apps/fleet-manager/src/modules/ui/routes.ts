import { Hono } from "hono";
import type { AppEnv } from "../../types";

/**
 * /ui router (mounted at "/ui" in app.ts): the web control panel for the bot
 * fleet, organised into three tabs that mirror the control-plane's concerns:
 *
 *   Provisioning — create/reap gateways, provision bots, drive lifecycle
 *                  (stop / reassign / restart / delete).
 *   Monitoring   — read-only "traffic lights" per bot + per gateway (see below).
 *   Logs         — a Gateway -> Bot -> chat tree; each bot expands to its chat
 *                  transcript with a per-message delivery-status badge
 *                  (received / pending / sending / sent / dlq).
 *
 * Architecture: this module is a THIN CLIENT. It serves one static HTML page; all
 * behaviour is the browser calling the SAME JSON API the CLI uses:
 *   GET/POST /bots, POST /bots/:id/{stop,restart}, PATCH/DELETE /bots/:id,
 *   GET/POST/DELETE /gateways, GET /personas,
 *   GET /monitor (fleet outbox health), GET /monitor/bots/:id/messages (chat log).
 * No business logic lives here, so the DDD layering is preserved: the UI is just
 * another consumer of the controller/service surface, not a second code path.
 *
 * Traffic lights — FOUR lights, honest about which
 * are authoritative vs derived vs not-yet-probed:
 *   1. Bot        — lifecycle: D1 bots.status (+ live DO stats). AUTHORITATIVE.
 *   2. Gateway    — container health from the 5-min liveness probe (GET
 *                   /connections), independent of the D1 membership status:
 *                   active=reachable+sockets (green), inactive=reachable+no
 *                   sockets (yellow), degraded=unreachable/off-roster (red),
 *                   stale/never-probed=gray. AUTHORITATIVE.
 *   3. Bot -> GW  — DERIVED from the outbox HANDOFF, self-contained (no coupling to
 *                   the bot/gw lights): DLQ or a reply STUCK un-SENT past STALL_TTL
 *                   => red; replies in flight => yellow; recently handed off (SENT
 *                   within FRESH_TTL) => green; idle => gray. Stall-age catches a
 *                   dead bot/drainer that never even reaches a DLQ.
   *   4. GW -> tg/wa— the bot's MTProto socket. A KNOWN connect failure observed by
   *                   the 5-min heal sweep and persisted on the bot row
   *                   (last_conn_error, e.g. AUTH_KEY_DUPLICATED), still fresh => red;
   *                   else recency of the last SENT: fresh => green, else GREY =
   *                   "unknown / idle". yellow (connecting) still needs a future live
   *                   GET /connection/status probe (never *claim* unobserved liveness,
   *                   but DO surface an observed failure).
 *
 * Served BY this Worker => same-origin (no CORS), behind the same Cloudflare
 * Access app. REST + polling (5s), no websockets: a control plane needs periodic
 * state, not a live socket.
 *
 * The page is inlined as a template literal (no bundler for one internal page).
 * The client script uses string concatenation and avoids backticks / template
 * placeholders so it never collides with this outer literal.
 */
const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Fleet Manager — Bot Control Plane</title>
<style>
  :root { --fg:#1a1a1a; --muted:#6b7280; --line:#e5e7eb; --accent:#2563eb; }
  * { box-sizing: border-box; }
  body { font-family: system-ui, sans-serif; color: var(--fg); max-width: 1080px; margin: 1.5rem auto; padding: 0 1rem; }
  h2 { margin: 0 0 1rem; }
  h3 { margin: 0 0 .6rem; font-size: 1rem; }
  .panel { border: 1px solid var(--line); border-radius: 8px; padding: 1rem; margin-bottom: 1rem; }
  .row { display: flex; gap: .6rem; align-items: center; flex-wrap: wrap; }
  .row.spread { justify-content: space-between; }
  label { display: inline-flex; gap: .35rem; align-items: center; font-size: .9rem; }
  input, select, button, textarea { font: inherit; padding: .35rem .5rem; border: 1px solid var(--line); border-radius: 6px; }
  button { cursor: pointer; background: #f9fafb; }
  button:hover:not(:disabled) { background: #f0f1f3; }
  button:disabled { opacity: .5; cursor: default; }
  button.primary { background: var(--accent); color: #fff; border-color: var(--accent); }
  button.danger { color: #b91c1c; border-color: #f0c4c4; }
  .muted { color: var(--muted); font-size: .85rem; margin-top: .6rem; }
  table { width: 100%; border-collapse: collapse; font-size: .88rem; }
  th, td { text-align: left; padding: .4rem .5rem; border-bottom: 1px solid var(--line); white-space: nowrap; }
  th { color: var(--muted); font-weight: 600; }
  td.mono, .mono { font-variant-numeric: tabular-nums; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  .badge { font-size: .75rem; padding: .1rem .45rem; border-radius: 999px; text-transform: uppercase; letter-spacing: .02em; }
  .b-running { background: #dcfce7; color: #166534; }
  .b-stopped { background: #f3f4f6; color: #374151; }
  .b-provisioning { background: #dbeafe; color: #1e40af; }
  .b-failed { background: #fee2e2; color: #991b1b; }
  .b-active { background: #dcfce7; color: #166534; }
  .b-draining { background: #fef9c3; color: #854d0e; }
  .b-reaped { background: #f3f4f6; color: #374151; }
  .b-received { background: #e0e7ff; color: #3730a3; }
  .b-pending { background: #fef9c3; color: #854d0e; }
  .b-sending { background: #dbeafe; color: #1e40af; }
  .b-sent { background: #dcfce7; color: #166534; }
  .b-dlq { background: #fee2e2; color: #991b1b; }
  .status { margin-top: .5rem; font-size: .85rem; color: var(--muted); }
  .status.ok { color: #166534; }
  .status.err { color: #b91c1c; }
  .empty { color: var(--muted); font-style: italic; padding: .6rem .5rem; }
  /* tabs */
  .tabs { display: flex; gap: .3rem; margin-bottom: 1rem; border-bottom: 1px solid var(--line); }
  .tabs button { border: none; border-bottom: 2px solid transparent; border-radius: 0; background: none; padding: .5rem .9rem; color: var(--muted); font-size: .95rem; }
  .tabs button.active { color: var(--fg); border-bottom-color: var(--accent); font-weight: 600; }
  .tab { display: none; }
  .tab.active { display: block; }
  /* traffic lights */
  .light { display: inline-block; width: 12px; height: 12px; border-radius: 50%; background: #d1d5db; vertical-align: middle; }
  .l-green { background: #22c55e; } .l-yellow { background: #eab308; }
  .l-red { background: #ef4444; } .l-gray { background: #d1d5db; }
  th.lt, td.lt { text-align: center; }
  .legend { font-size: .8rem; color: var(--muted); margin-top: .8rem; display: flex; gap: 1.2rem; flex-wrap: wrap; }
  .legend .light { margin-right: .3rem; }
  .gwlights { display: flex; gap: 1.2rem; flex-wrap: wrap; }
  .gwlight { display: flex; align-items: center; gap: .4rem; font-size: .88rem; }
  /* logs tree */
  details.tree { margin: .15rem 0; }
  details.tree > summary { cursor: pointer; padding: .3rem .2rem; font-size: .9rem; }
  details.bot { margin-left: 1.2rem; }
  details.bot > summary { color: #374151; }
  .log { margin: .3rem 0 .6rem 1.6rem; border-left: 2px solid var(--line); padding-left: .7rem; }
  .chat { margin-bottom: .6rem; }
  .chat h4 { margin: .3rem 0; font-size: .78rem; color: var(--muted); font-weight: 600; }
  .msg { display: flex; gap: .5rem; align-items: baseline; padding: .18rem 0; font-size: .85rem; border-bottom: 1px dotted var(--line); }
  .msg .who { width: 2.6rem; flex: none; font-size: .68rem; color: var(--muted); text-transform: uppercase; }
  .msg .txt { flex: 1; white-space: pre-wrap; word-break: break-word; }
  .msg .txt.me { color: #1e40af; }
  .msg time { flex: none; font-size: .7rem; color: var(--muted); }
  .msg .err { color: #b91c1c; font-size: .72rem; }
</style>
</head>
<body>
<h2>Fleet Manager — Bot Control Plane</h2>

<div class="tabs">
  <button id="tab-provision-btn" class="active" data-tab="provision">Provisioning</button>
  <button id="tab-monitor-btn" data-tab="monitor">Monitoring</button>
  <button id="tab-logs-btn" data-tab="logs">Logs</button>
</div>

<!-- ─────────────────────────── PROVISIONING ─────────────────────────── -->
<div id="tab-provision" class="tab active">
  <section class="panel">
    <div class="row spread">
      <h3>Gateways (<span id="gwcount">0</span>)</h3>
      <button id="gwrefresh">Refresh</button>
    </div>
    <div class="row">
      <label>gatewayId <input id="f_gw" placeholder="auto (gw-N)" size="10" /></label>
      <label>label <input id="f_gwlabel" placeholder="optional" size="16" /></label>
      <button id="gwprovision" class="primary">Add gateway</button>
    </div>
    <table>
      <thead><tr><th>gateway</th><th>label</th><th>status</th><th>actions</th></tr></thead>
      <tbody id="gwrows"></tbody>
    </table>
    <div id="gwempty" class="empty" style="display:none">no gateways yet</div>
  </section>

  <section class="panel">
    <h3>Provision a bot</h3>
    <div class="row">
      <label>botId <input id="f_bot" placeholder="auto (bot-N)" size="10" /></label>
      <label>gateway <select id="gw"></select></label>
      <label>persona <select id="persona"></select></label>
      <label>runMinutes <input id="f_rm" type="number" min="1" placeholder="90" style="width:6rem" /></label>
      <label><input id="f_force" type="checkbox" /> force</label>
    </div>
    <div class="row">
      <label>api_id <input id="f_apiId" placeholder="123456" size="10" /></label>
      <label>api_hash <input id="f_apiHash" placeholder="32 hex chars" size="24" /></label>
      <label>phone <input id="f_phone" placeholder="+4477..." size="16" /></label>
    </div>
    <div class="row" style="align-items:flex-start">
      <label style="flex:1">sessionCredential
        <textarea id="f_session" placeholder="paste StringSession from local auth-ui (pnpm auth:ui)"
          style="width:100%;height:56px;font:12px monospace"></textarea>
      </label>
      <button id="provision" class="primary" style="margin-top:1.4rem">Provision</button>
    </div>
    <div class="muted">Telegram creds are per-bot: mint the session locally (<span class="mono">pnpm auth:ui</span>). It is stored in the registry and sent to the gateway. <b>Secret — do not paste in chat.</b></div>
    <div class="muted">available gateways: <span id="gwroster" class="mono">...</span></div>
    <div class="muted">available personas: <span id="personaroster" class="mono">...</span></div>
  </section>

  <section class="panel">
    <div class="row spread">
      <h3>Bots (<span id="count">0</span>)</h3>
      <div class="row">
        <label><input id="auto" type="checkbox" checked /> auto-refresh</label>
        <button id="refresh">Refresh</button>
      </div>
    </div>
    <table>
      <thead><tr>
        <th>bot</th><th>gateway</th><th>persona</th><th>status</th><th>replies</th>
        <th>cursor</th><th>next poll</th><th>elapsed</th><th>actions</th>
      </tr></thead>
      <tbody id="rows"></tbody>
    </table>
    <div id="empty" class="empty" style="display:none">no bots provisioned yet</div>
  </section>
</div>

<!-- ─────────────────────────── MONITORING ─────────────────────────── -->
<div id="tab-monitor" class="tab">
  <section class="panel">
    <div class="row spread">
      <h3>Gateways</h3>
      <button id="monrefresh">Refresh</button>
    </div>
    <div id="gwlights" class="gwlights"><span class="empty">no gateways</span></div>
  </section>

  <section class="panel">
    <h3>Bot traffic lights</h3>
    <table>
      <thead><tr>
        <th>bot</th><th>gateway</th>
        <th class="lt">bot</th><th class="lt">gateway</th><th class="lt">bot&rarr;gw</th><th class="lt">gw&rarr;platform</th>
        <th class="num">recv</th><th class="num">pend</th><th class="num">sending</th><th class="num">sent</th><th class="num">dlq</th>
        <th>last send</th>
      </tr></thead>
      <tbody id="monrows"></tbody>
    </table>
    <div id="monempty" class="empty" style="display:none">no bots provisioned yet</div>
    <div class="legend">
      <span><span class="light l-green"></span>ok</span>
      <span><span class="light l-yellow"></span>processing / in-flight</span>
      <span><span class="light l-red"></span>degraded / failed</span>
      <span><span class="light l-gray"></span>unknown / idle</span>
      <span><b>gw&rarr;platform</b> red = a connect failure the heal sweep observed (e.g. AUTH_KEY_DUPLICATED); else green = a send within 15m; gray = idle. yellow (connecting) needs a future live socket probe.</span>
    </div>
  </section>
</div>

<!-- ─────────────────────────── LOGS ─────────────────────────── -->
<div id="tab-logs" class="tab">
  <section class="panel">
    <div class="row spread">
      <h3>Chat logs — Gateway &rarr; Bot &rarr; conversation</h3>
      <div class="row">
        <label>limit <input id="loglimit" type="number" min="1" max="1000" value="200" style="width:5rem" /></label>
        <button id="logreload">Reload tree</button>
      </div>
    </div>
    <div class="muted">Expand a bot to load its transcript. Each line shows a delivery-status badge: <span class="badge b-received">received</span> <span class="badge b-pending">pending</span> <span class="badge b-sending">sending</span> <span class="badge b-sent">sent</span> <span class="badge b-dlq">dlq</span></div>
    <div id="logtree" style="margin-top:.8rem"><span class="empty">loading...</span></div>
  </section>
</div>

<div id="status" class="status">loading...</div>

<script>
  (function () {
    var $ = function (id) { return document.getElementById(id); };
    var autoTimer = null;
    var activeGateways = [];   // active gateway ids (drive provision/reassign dropdowns)
    var stateGateways = [];    // full gateway rows
    var stateBots = [];        // bot rows (with .stats when live)
    var stateHealth = {};      // bot_id -> outbox health (from /monitor)

    function log(msg, kind) {
      var el = $("status");
      el.textContent = msg;
      el.className = "status " + (kind || "");
    }
    function j(res) { return res.json().catch(function () { return null; }); }

    function fmtRel(ms) {
      if (ms == null) return "-";
      var d = Math.round((ms - Date.now()) / 1000);
      if (d <= 0) return "due";
      if (d < 90) return "in " + d + "s";
      return "in " + Math.round(d / 60) + "m";
    }
    function fmtAgo(ms) {
      if (ms == null) return "never";
      var d = Math.round((Date.now() - ms) / 1000);
      if (d < 0) return "just now";
      if (d < 90) return d + "s ago";
      if (d < 5400) return Math.round(d / 60) + "m ago";
      if (d < 172800) return Math.round(d / 3600) + "h ago";
      return Math.round(d / 86400) + "d ago";
    }
    function fmtClock(ms) {
      if (ms == null) return "";
      return new Date(ms).toLocaleTimeString();
    }
    function td(text, cls) {
      var c = document.createElement("td");
      c.textContent = text;
      if (cls) c.className = cls;
      return c;
    }
    function badge(s) {
      var span = document.createElement("span");
      span.className = "badge b-" + String(s).toLowerCase();
      span.textContent = s;
      return span;
    }
    function badgeCell(s) {
      var c = document.createElement("td");
      c.appendChild(badge(s));
      return c;
    }
    function light(kind, title) {
      var s = document.createElement("span");
      s.className = "light l-" + kind;
      s.title = title;
      return s;
    }
    function lightCell(kind, title) {
      var c = document.createElement("td");
      c.className = "lt";
      c.appendChild(light(kind, title));
      return c;
    }

    // ── tabs ────────────────────────────────────────────────────────────
    function showTab(name) {
      ["provision", "monitor", "logs"].forEach(function (t) {
        $("tab-" + t).classList.toggle("active", t === name);
        $("tab-" + t + "-btn").classList.toggle("active", t === name);
      });
      if (name === "logs" && $("logtree").dataset.built !== "1") renderLogTree();
    }

    // ── gateways (shared: provisioning table + monitor lights + logs tree) ─
    function loadGateways() {
      return fetch("/gateways").then(j).then(function (d) {
        var gws = (d && d.gateways) || [];
        stateGateways = gws;
        activeGateways = gws
          .filter(function (g) { return g.status === "active"; })
          .map(function (g) { return g.gateway_id; });
        // provision dropdown — ACTIVE only
        var sel = $("gw");
        sel.innerHTML = "";
        activeGateways.forEach(function (gid) {
          var o = document.createElement("option");
          o.value = gid; o.textContent = gid;
          sel.appendChild(o);
        });
        $("gwroster").textContent = gws.length
          ? gws.map(function (g) { return g.gateway_id; }).join(", ")
          : "(none - provision one above)";
        // provisioning management table
        var tb = $("gwrows");
        tb.innerHTML = "";
        $("gwcount").textContent = gws.length;
        $("gwempty").style.display = gws.length ? "none" : "block";
        gws.forEach(function (g) {
          var tr = document.createElement("tr");
          tr.appendChild(td(g.gateway_id));
          tr.appendChild(td(g.label || "-"));
          tr.appendChild(badgeCell(g.status));
          tr.appendChild(gwActionCell(g));
          tb.appendChild(tr);
        });
        renderGatewayLights();
      }).catch(function (e) { $("gwroster").textContent = "failed: " + e; });
    }

    function gwActionCell(g) {
      var c = document.createElement("td");
      var reap = document.createElement("button");
      reap.textContent = "Reap";
      reap.className = "danger";
      reap.onclick = function () {
        if (!confirm("Reap " + g.gateway_id + "? Removes it from the roster (blocked if bots are pinned).")) return;
        doAction("DELETE", "/gateways/" + encodeURIComponent(g.gateway_id), "reap " + g.gateway_id);
      };
      c.appendChild(reap);
      return c;
    }

    function provisionGateway() {
      var gatewayId = $("f_gw").value.trim();
      var label = $("f_gwlabel").value.trim();
      var body = {};
      if (gatewayId) body.gatewayId = gatewayId;
      if (label) body.label = label;
      $("gwprovision").disabled = true;
      fetch("/gateways", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
        .then(function (r) { return j(r).then(function (d) { return { ok: r.ok, d: d }; }); })
        .then(function (res) {
          if (res.ok && res.d && res.d.ok) {
            log("added gateway " + (res.d.gateway ? res.d.gateway.gateway_id : ""), "ok");
            $("f_gw").value = ""; $("f_gwlabel").value = "";
            loadGateways();
          } else {
            log("add gateway failed: " + errText(res.d), "err");
          }
        })
        .catch(function (e) { log("add gateway error: " + e, "err"); })
        .finally(function () { $("gwprovision").disabled = false; });
    }

    function loadPersonas() {
      return fetch("/personas").then(j).then(function (d) {
        var sel = $("persona");
        sel.innerHTML = "";
        var none = document.createElement("option");
        none.value = ""; none.textContent = "\u2014 none \u2014";
        sel.appendChild(none);
        var ps = (d && d.personas) || [];
        ps.forEach(function (p) {
          var o = document.createElement("option");
          o.value = p; o.textContent = p;
          sel.appendChild(o);
        });
        $("personaroster").textContent = ps.length
          ? ps.join(", ")
          : "(none - discovery disabled or empty catalog)";
      }).catch(function (e) { $("personaroster").textContent = "failed: " + e; });
    }

    function reassignControls(bot) {
      var sel = document.createElement("select");
      var opts = activeGateways.slice();
      if (opts.indexOf(bot.gateway_id) === -1) opts.unshift(bot.gateway_id);
      opts.forEach(function (gid) {
        var o = document.createElement("option");
        o.value = gid;
        o.textContent = gid === bot.gateway_id ? gid + " (current)" : gid;
        if (gid === bot.gateway_id) o.selected = true;
        sel.appendChild(o);
      });
      var btn = document.createElement("button");
      btn.textContent = "Reassign";
      btn.onclick = function () {
        var target = sel.value;
        if (target === bot.gateway_id) { log("bot " + bot.bot_id + " already on " + target, ""); return; }
        var note = bot.status === "running" ? " It will switch gateways live (no restart)." : "";
        if (!confirm("Reassign " + bot.bot_id + " to " + target + "?" + note)) return;
        patchBot(bot.bot_id, { gatewayId: target }, "reassign " + bot.bot_id + " -> " + target);
      };
      return { sel: sel, btn: btn };
    }

    function actionCell(bot) {
      var c = document.createElement("td");
      var space = function () { return document.createTextNode(" "); };
      var stop = document.createElement("button");
      stop.textContent = "Stop";
      stop.disabled = bot.status !== "running";
      stop.onclick = function () {
        doAction("POST", "/bots/" + encodeURIComponent(bot.bot_id) + "/stop", "stop " + bot.bot_id);
      };
      var restart = document.createElement("button");
      restart.textContent = "Restart";
      restart.disabled = bot.status !== "running";
      restart.onclick = function () {
        if (!confirm("Restart " + bot.bot_id + "? Recycles the run (cursor/counters reset).")) return;
        doAction("POST", "/bots/" + encodeURIComponent(bot.bot_id) + "/restart", "restart " + bot.bot_id);
      };
      var del = document.createElement("button");
      del.textContent = "Delete";
      del.className = "danger";
      del.onclick = function () {
        if (!confirm("Delete " + bot.bot_id + "? This stops the bot and removes it from the registry.")) return;
        doAction("DELETE", "/bots/" + encodeURIComponent(bot.bot_id), "delete " + bot.bot_id);
      };
      var ra = reassignControls(bot);
      c.appendChild(stop);
      c.appendChild(space());
      c.appendChild(restart);
      c.appendChild(space());
      c.appendChild(ra.sel);
      c.appendChild(space());
      c.appendChild(ra.btn);
      c.appendChild(space());
      c.appendChild(del);
      return c;
    }

    // ── bots (provisioning management table) ─────────────────────────────
    function refresh() {
      // Don't clobber an in-progress reassign: skip if a row <select> is focused.
      var ae = document.activeElement;
      if (ae && ae.tagName === "SELECT" && $("rows").contains(ae)) {
        return Promise.resolve();
      }
      return fetch("/bots?live=1").then(j).then(function (d) {
        var bots = (d && d.bots) || [];
        stateBots = bots;
        var tb = $("rows");
        tb.innerHTML = "";
        $("count").textContent = bots.length;
        $("empty").style.display = bots.length ? "none" : "block";
        bots.forEach(function (b) {
          var s = (b.stats && !b.stats.error) ? b.stats : null;
          var tr = document.createElement("tr");
          tr.appendChild(td(b.bot_id));
          tr.appendChild(td(b.gateway_id));
          tr.appendChild(td(b.persona_name || "-"));
          tr.appendChild(badgeCell(b.status));
          tr.appendChild(td(s ? String(s.count) : "-", "num"));
          tr.appendChild(td(s ? String(s.cursor) : "-", "num"));
          tr.appendChild(td(s ? fmtRel(s.nextAlarm) : ((b.stats && b.stats.error) ? "stats err" : "-"), "mono"));
          tr.appendChild(td(
            (s && s.elapsedMin != null) ? (s.elapsedMin + "/" + s.runMinutes + "m") : "-", "mono"));
          tr.appendChild(actionCell(b));
          tb.appendChild(tr);
        });
        log("updated " + new Date().toLocaleTimeString(), "ok");
        renderMonitor();
      }).catch(function (e) { log("refresh failed: " + e, "err"); });
    }

    // ── monitoring (traffic lights) ──────────────────────────────────────
    function loadMonitor() {
      return fetch("/monitor").then(j).then(function (d) {
        stateHealth = (d && d.health) || {};
        renderMonitor();
      }).catch(function () { /* health is best-effort; leave prior state */ });
    }

    function renderGatewayLights() {
      var box = $("gwlights");
      box.innerHTML = "";
      if (!stateGateways.length) { box.innerHTML = "<span class=\\"empty\\">no gateways</span>"; return; }
      stateGateways.forEach(function (g) {
        var kind, note;
        if (g.status !== "active") {
          kind = "red"; note = "degraded (" + g.status + ")";
        } else if (!gwProbeFresh(g)) {
          kind = "gray"; note = "no recent probe";
        } else if (g.last_probe_health === "active") {
          kind = "green"; note = "active (sockets live)";
        } else if (g.last_probe_health === "inactive") {
          kind = "yellow"; note = "inactive (no live sockets)";
        } else {
          kind = "red"; note = "degraded (unreachable)";
        }
        var w = document.createElement("div");
        w.className = "gwlight";
        w.appendChild(light(kind, "gateway " + note));
        var t = document.createElement("span");
        t.textContent = g.gateway_id + (g.label ? " (" + g.label + ")" : "") + " — " + note;
        w.appendChild(t);
        box.appendChild(w);
      });
    }

    function gatewayRowOf(gid) {
      for (var i = 0; i < stateGateways.length; i++) {
        if (stateGateways[i].gateway_id === gid) return stateGateways[i];
      }
      return null;
    }

    // Shared freshness windows for the derived/live lights, so every light applies
    // staleness UNIFORMLY (a success signal older than its window is "unknown", not
    // "green"). FRESH_TTL = how recent a positive signal (probe / last SENT) must be
    // to still read green; STALL_TTL = how long a reply may sit un-SENT before the
    // handoff is called stuck (red). Both tunable.
    var FRESH_TTL_MS = 15 * 60 * 1000; // 15 min (== the 5-min sweep x 3 ticks)
    var STALL_TTL_MS = 5 * 60 * 1000; // 5 min: well above the ~1s normal handoff, below overnight idle
    // A container-liveness probe is written by the 5-min health sweep. Treat it as a
    // live signal only within FRESH_TTL; older/absent -> gray (never CLAIM reachability
    // we did not recently observe).
    function gwProbeFresh(g) {
      return g && g.last_probe_at != null && (Date.now() - g.last_probe_at) < FRESH_TTL_MS;
    }

    // Light semantics: green = ok, yellow = PROCESSING / in-flight (transient),
    // red = DEGRADED / failed, gray = unknown / idle.

    // Light #1 — bot lifecycle (authoritative: D1 status + live DO reachability).
    function botLight(b) {
      if (b.status === "failed") return ["red", "lifecycle: failed"];
      if (b.status === "running") {
        if (b.stats && b.stats.error) return ["red", "running but DO unreachable (degraded)"];
        return ["green", "running"];
      }
      if (b.status === "provisioning") return ["yellow", "provisioning (starting up)"];
      return ["gray", "lifecycle: " + b.status]; // stopped etc.
    }
    // Light #2 — gateway health, from the container-liveness probe recorded by
    // the 5-min sweep (independent of the D1 membership status). Three states:
    //   active   (green)  = reachable, >=1 live socket
    //   inactive (yellow) = reachable, zero live sockets (up but channels dark)
    //   degraded (red)    = probe unreachable / not in roster / any other status
    // A stale or absent probe => gray "no recent probe" (never claim unobserved).
    function gwLight(b) {
      var g = gatewayRowOf(b.gateway_id);
      if (!g) return ["red", "degraded: gateway " + b.gateway_id + " not in roster"];
      if (g.status !== "active") return ["red", "degraded: gateway " + g.status];
      if (!gwProbeFresh(g)) return ["gray", "no recent probe"];
      var h = g.last_probe_health;
      if (h === "active") return ["green", "active (reachable, sockets live)"];
      if (h === "inactive") return ["yellow", "inactive (reachable, no live sockets)"];
      return ["red", "degraded (container unreachable)"];
    }
    // Light #3 — bot -> gateway HANDOFF (DERIVED from the outbox; SELF-CONTAINED, no
    // coupling to the bot/gw lights — the row shows those separately, and stall-age
    // catches a dead upstream DIRECTLY):
    //   dlq > 0                              -> red    (replies dead-lettered on this hop)
    //   oldest un-SENT older than STALL_TTL  -> red    (STUCK: dead bot/drainer never
    //                                                    attempts, or gateway keeps failing —
    //                                                    the case a DLQ-only rule would MISS,
    //                                                    since a dead drainer never DLQs)
    //   pending/sending, still within STALL  -> yellow (handoff in flight, healthy)
    //   queue clean + a SENT within FRESH    -> green  (recently handed off)
    //   queue empty + no recent SENT         -> gray   (idle / never)
    function botToGwLight(h) {
      if (!h) return ["gray", "no messages yet"];
      var now = Date.now();
      if (h.dlq > 0) return ["red", h.dlq + " repl" + (h.dlq === 1 ? "y" : "ies") + " dead-lettered (DLQ)"];
      if (h.oldestUnsentAt != null && now - h.oldestUnsentAt > STALL_TTL_MS) {
        return ["red", "handoff stuck: oldest un-sent reply " + fmtAgo(h.oldestUnsentAt)];
      }
      var inflight = (h.pending || 0) + (h.sending || 0);
      if (inflight > 0) return ["yellow", inflight + " repl" + (inflight === 1 ? "y" : "ies") + " in flight"];
      if (h.lastSentAt != null && now - h.lastSentAt < FRESH_TTL_MS) {
        return ["green", "recently handed off, last send " + fmtAgo(h.lastSentAt)];
      }
      return ["gray", h.lastSentAt != null ? "idle, last send " + fmtAgo(h.lastSentAt) : "no replies sent yet"];
    }
    // Light #4 — gateway -> platform (tg/wa). Two signals, negative wins:
    //   RED    a KNOWN connect failure observed by the 5-min heal sweep and persisted
    //          on the bot row (last_conn_error, e.g. AUTH_KEY_DUPLICATED /
    //          session_unauthorized), still FRESH. An OBSERVED negative is shown even
    //          though we never CLAIM unobserved reachability — suppressing a known
    //          failure (the old green/gray-only rule) was the bug this fixes.
    //   green  no fresh error + a SENT within FRESH_TTL (recently reached the platform)
    //   gray   no fresh error + no recent send (idle / unknown)
    // A STALE error (older than FRESH_TTL) is NOT trusted -> falls back to send-recency.
    // yellow (connecting/retrying) still needs a live GET /connection/status probe.
    function gwToPlatformLight(b, h) {
      if (b && b.last_conn_error && b.last_conn_error_at != null &&
          Date.now() - b.last_conn_error_at < FRESH_TTL_MS) {
        return ["red", "connect failed: " + b.last_conn_error];
      }
      if (!h || h.lastSentAt == null) return ["gray", "no replies sent yet"];
      if (Date.now() - h.lastSentAt < FRESH_TTL_MS) {
        return ["green", "delivered to platform, last send " + fmtAgo(h.lastSentAt)];
      }
      return ["gray", "no recent send (last " + fmtAgo(h.lastSentAt) + ")"];
    }

    function renderMonitor() {
      var tb = $("monrows");
      tb.innerHTML = "";
      $("monempty").style.display = stateBots.length ? "none" : "block";
      stateBots.forEach(function (b) {
        var h = stateHealth[b.bot_id];
        var tr = document.createElement("tr");
        tr.appendChild(td(b.bot_id));
        tr.appendChild(td(b.gateway_id));
        var l1 = botLight(b), l2 = gwLight(b);
        var l3 = botToGwLight(h), l4 = gwToPlatformLight(b, h);
        tr.appendChild(lightCell(l1[0], l1[1]));
        tr.appendChild(lightCell(l2[0], l2[1]));
        tr.appendChild(lightCell(l3[0], l3[1]));
        tr.appendChild(lightCell(l4[0], l4[1]));
        tr.appendChild(td(h ? String(h.received) : "0", "num"));
        tr.appendChild(td(h ? String(h.pending) : "0", "num"));
        tr.appendChild(td(h ? String(h.sending) : "0", "num"));
        tr.appendChild(td(h ? String(h.sent) : "0", "num"));
        tr.appendChild(td(h ? String(h.dlq) : "0", "num"));
        tr.appendChild(td(h && h.lastSentAt != null ? fmtAgo(h.lastSentAt) : "never", "mono"));
        tb.appendChild(tr);
      });
    }

    // ── logs (Gateway -> Bot -> chat tree) ───────────────────────────────
    function renderLogTree() {
      var root = $("logtree");
      root.innerHTML = "";
      root.dataset.built = "1";
      // group bots by gateway_id; include a synthetic bucket for any gateway id
      // that is no longer in the roster so no bot is ever hidden.
      var seen = {};
      var order = [];
      stateGateways.forEach(function (g) { seen[g.gateway_id] = []; order.push(g.gateway_id); });
      stateBots.forEach(function (b) {
        if (!seen[b.gateway_id]) { seen[b.gateway_id] = []; order.push(b.gateway_id); }
        seen[b.gateway_id].push(b);
      });
      if (!order.length) { root.innerHTML = "<span class=\\"empty\\">no gateways / bots yet</span>"; return; }
      order.forEach(function (gid) {
        var bots = seen[gid] || [];
        var g = document.createElement("details");
        g.className = "tree";
        var gs = document.createElement("summary");
        var grow = gatewayRowOf(gid);
        var st = grow ? grow.status : null;
        gs.textContent = gid + (st ? " [" + st + "]" : " [not in roster]") + " — " + bots.length + " bot(s)";
        g.appendChild(gs);
        if (!bots.length) {
          var e = document.createElement("div");
          e.className = "empty"; e.textContent = "no bots on this gateway";
          g.appendChild(e);
        }
        bots.forEach(function (b) { g.appendChild(botLogNode(b)); });
        root.appendChild(g);
      });
    }

    function botLogNode(b) {
      var d = document.createElement("details");
      d.className = "tree bot";
      var s = document.createElement("summary");
      s.textContent = b.bot_id + (b.persona_name ? " (" + b.persona_name + ")" : "") + " — " + b.status;
      d.appendChild(s);
      var body = document.createElement("div");
      body.className = "log";
      body.innerHTML = "<span class=\\"empty\\">expand to load…</span>";
      d.appendChild(body);
      d.addEventListener("toggle", function () {
        if (d.open && d.dataset.loaded !== "1") loadChatLog(b.bot_id, body, d);
      });
      return d;
    }

    function loadChatLog(botId, body, det) {
      body.innerHTML = "<span class=\\"empty\\">loading…</span>";
      var lim = Number($("loglimit").value) || 200;
      fetch("/monitor/bots/" + encodeURIComponent(botId) + "/messages?limit=" + lim)
        .then(j)
        .then(function (d) {
          det.dataset.loaded = "1";
          var msgs = (d && d.messages) || [];
          renderChatLog(body, botId, msgs);
        })
        .catch(function (e) { body.textContent = "load failed: " + e; });
    }

    function renderChatLog(body, botId, msgs) {
      body.innerHTML = "";
      var head = document.createElement("div");
      head.className = "row spread";
      var hl = document.createElement("span");
      hl.className = "muted";
      hl.style.marginTop = "0";
      hl.textContent = msgs.length + " message(s)";
      var rl = document.createElement("button");
      rl.textContent = "Reload";
      rl.onclick = function () { loadChatLog(botId, body, body.parentNode); };
      head.appendChild(hl); head.appendChild(rl);
      body.appendChild(head);
      if (!msgs.length) {
        var e = document.createElement("div");
        e.className = "empty"; e.textContent = "no messages";
        body.appendChild(e);
        return;
      }
      // group by chatId, preserve first-seen order (msgs are oldest->newest)
      var chats = {}; var chatOrder = [];
      msgs.forEach(function (m) {
        if (!chats[m.chatId]) { chats[m.chatId] = []; chatOrder.push(m.chatId); }
        chats[m.chatId].push(m);
      });
      chatOrder.forEach(function (cid) {
        var wrap = document.createElement("div");
        wrap.className = "chat";
        var h = document.createElement("h4");
        h.textContent = "chat #" + cid + " — " + chats[cid].length + " msg";
        wrap.appendChild(h);
        chats[cid].forEach(function (m) {
          var row = document.createElement("div");
          row.className = "msg";
          var who = document.createElement("span");
          who.className = "who";
          who.textContent = m.fromMe ? "bot" : "user";
          var b = badge(m.deliveryState);
          var txt = document.createElement("span");
          txt.className = "txt" + (m.fromMe ? " me" : "");
          txt.textContent = m.content;
          if (m.lastError) {
            var er = document.createElement("span");
            er.className = "err";
            er.textContent = " ⚠ " + m.lastError + (m.attempts ? " (attempt " + m.attempts + ")" : "");
            txt.appendChild(er);
          }
          var tm = document.createElement("time");
          tm.textContent = fmtClock(m.ts);
          row.appendChild(who);
          row.appendChild(b);
          row.appendChild(txt);
          row.appendChild(tm);
          wrap.appendChild(row);
        });
        body.appendChild(wrap);
      });
    }

    // ── provisioning: create bot ─────────────────────────────────────────
    function provision() {
      var botId = $("f_bot").value.trim();
      var gatewayId = $("gw").value;
      var personaName = $("persona").value;
      var rm = $("f_rm").value.trim();
      var force = $("f_force").checked;
      var apiId = $("f_apiId").value.trim();
      var apiHash = $("f_apiHash").value.trim();
      var phone = $("f_phone").value.trim();
      var session = $("f_session").value.trim();
      if (!gatewayId) { log("pick a gateway first (none available?)", "err"); return; }
      if (!apiId || !apiHash || !phone || !session) {
        log("api_id, api_hash, phone and sessionCredential are all required", "err"); return;
      }
      var body = {
        gatewayId: gatewayId,
        force: force,
        apiId: apiId,
        apiHash: apiHash,
        phone: phone,
        sessionCredential: session,
      };
      if (botId) body.botId = botId;
      if (personaName) body.personaName = personaName;
      if (rm) body.runMinutes = Number(rm);
      $("provision").disabled = true;
      fetch("/bots", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
        .then(function (r) { return j(r).then(function (d) { return { ok: r.ok, d: d }; }); })
        .then(function (res) {
          if (res.ok && res.d && res.d.ok) {
            var id = res.d.bot ? res.d.bot.bot_id : (botId || "bot");
            var idn = res.d.identity;
            var who = idn ? (idn.username ? " as @" + idn.username : " as id " + idn.id) : "";
            log("provisioned " + id + " -> " + gatewayId + (personaName ? " [" + personaName + "]" : "") + who, "ok");
            $("f_bot").value = ""; $("f_apiId").value = ""; $("f_apiHash").value = "";
            $("f_phone").value = ""; $("f_session").value = "";
            refresh();
          } else {
            log("provision failed: " + errText(res.d), "err");
          }
        })
        .catch(function (e) { log("provision error: " + e, "err"); })
        .finally(function () { $("provision").disabled = false; });
    }

    function doAction(method, url, label) {
      fetch(url, { method: method })
        .then(function (r) { return j(r).then(function (d) { return { ok: r.ok, d: d }; }); })
        .then(function (res) {
          if (res.ok && res.d && res.d.ok) log(label + " ok", "ok");
          else log(label + " failed: " + errText(res.d), "err");
          refresh();
          loadGateways();
        })
        .catch(function (e) { log(label + " error: " + e, "err"); });
    }

    function patchBot(botId, body, label) {
      fetch("/bots/" + encodeURIComponent(botId), {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
        .then(function (r) { return j(r).then(function (d) { return { ok: r.ok, d: d }; }); })
        .then(function (res) {
          if (res.ok && res.d && res.d.ok) {
            log(label + " ok" + (res.d.reconfigured ? " (live)" : res.d.restarted ? " (restarted)" : " (registry only)"), "ok");
          } else {
            log(label + " failed: " + errText(res.d), "err");
          }
          refresh();
          loadGateways();
        })
        .catch(function (e) { log(label + " error: " + e, "err"); });
    }

    function errText(d) {
      if (!d) return "request error";
      if (d.error) return d.error + (d.known ? " (known: " + d.known.join(", ") + ")" : "");
      return JSON.stringify(d);
    }

    function tick() { refresh(); loadMonitor(); }
    function setAuto(on) {
      if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
      if (on) autoTimer = setInterval(tick, 5000);
    }

    // ── wiring ──────────────────────────────────────────────────────────
    var tabBtns = document.querySelectorAll(".tabs button");
    for (var i = 0; i < tabBtns.length; i++) {
      tabBtns[i].addEventListener("click", function (e) { showTab(e.target.getAttribute("data-tab")); });
    }
    $("provision").onclick = provision;
    $("gwprovision").onclick = provisionGateway;
    $("gwrefresh").onclick = loadGateways;
    $("refresh").onclick = tick;
    $("monrefresh").onclick = function () { loadGateways(); tick(); };
    $("logreload").onclick = renderLogTree;
    $("f_bot").addEventListener("keydown", function (e) { if (e.key === "Enter") provision(); });
    $("auto").addEventListener("change", function () { setAuto($("auto").checked); });

    Promise.all([loadGateways(), loadPersonas()]).then(function () { return Promise.all([refresh(), loadMonitor()]); });
    setAuto(true);
  })();
</script>
</body>
</html>`;

export const uiRoutes = new Hono<AppEnv>();

uiRoutes.get("/", (c) => c.html(PAGE));
