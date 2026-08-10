# Fleet Manager

The **control plane** for the bot fleet. It is the one place that knows **which bots
exist**, **which gateway each bot runs on**, and **how to start, move, and heal them**.

Fleet Manager itself is stateless — it holds no live sockets and runs no bot logic.
It keeps a small database (the registry), gives operators an HTTP API + web UI, and
tells the other services what to do.

---

## The pieces it coordinates

| Piece | What it is | Who owns it |
|---|---|---|
| **Bot** | One Telegram account the fleet operates. | Fleet Manager registry (source of truth for "which bots exist"). |
| **Gateway** | A container that holds the actual live Telegram sockets. Each gateway can host many bots. | Fleet Manager registry lists them; the gateway service runs them. |
| **Credential** | The pre-minted login — a StringSession plus the account's Telegram app credentials (`api_id` / `api_hash`) and phone — that opens a bot's socket without asking for an OTP. | Stored on the bot's registry row — the master copy of the session. |
| **Bot runtime (loop)** | The per-bot worker that decides when to reply. | The `bot-fleet` service. |

Fleet Manager talks to the gateway and bot-fleet services over internal service
bindings (direct service-to-service calls, no public internet hop).

---

## What it stores

A single registry table of bots. Each row has:

- identity: `bot_id`, which `gateway_id` it belongs to, its persona, its status
  (`provisioning` / `running` / `stopped` / `failed`),
- the login credential quad — `api_id`, `api_hash`, `phone`, and the StringSession.
  The two secrets (StringSession + `api_hash`) are stripped from every read API and
  the UI; the non-secret `api_id` / `phone` are returned so an operator can see which
  account a bot is bound to,
- a small **move cursor** used while a bot is being shifted between gateways (explained
  below).

There is also a small table listing the gateways that exist.

---

## HTTP API

```
POST   /bots                      create a bot, connect its socket, and start it
GET    /bots                      list all bots (?live=1 also fetches live counters)
GET    /bots/:id                  one bot + live counters
PATCH  /bots/:id                  change a bot's gateway and/or persona (declarative mapping update)
POST   /bots/:id/stop             stop a bot
POST   /bots/:id/restart          force a fresh run of a RUNNING bot (same mapping; cursor/counters reset)
DELETE /bots/:id                  stop and remove a bot

POST   /gateways                  register a new gateway
GET    /gateways                  list gateways
GET    /gateways/:id              one gateway
DELETE /gateways/:id              remove a gateway (blocked if bots are still on it, unless ?force=1)

GET    /personas                  list available personas (for the picker)
GET    /monitor                   fleet-wide outbox health for the monitoring board (all bots)
GET    /monitor/bots/:id/messages one bot's chat log (for the logs view)
GET    /ui                        web control panel (provisioning, monitoring, logs)
GET    /docs                      API reference (OpenAPI / Scalar UI)
```

(Gateways also expose an **internal-only** endpoint that a restarting gateway uses
to fetch its recovery list — see feature 4. It is not for operators.)

Reads never leak secrets: the login credential is stripped out before any bot is
returned.

---

## Core features

### 1. Bot Provisioning (create → connect → start)

When you create a bot, Fleet Manager does three things **in order**, so a bot is never
left half-alive:

1. Save the bot's row (including its credential) to the registry **first**, so the
   credential survives even if the next step fails and you retry.
2. Open the bot's live Telegram socket in its gateway.
3. Only if the socket is live, start the bot's reply loop.

If the socket fails to open, the bot is marked `failed` and the loop never starts — a
bot with no channel must not silently sit there polling.

### 2. Gateway Provisioning & Management

Register, list, and remove gateways. Removing a gateway is **refused if bots are still
pinned to it** (so you can't accidentally orphan running bots); use `?force=1` to
override. Removing a gateway also stops its container immediately instead of waiting for
it to idle out.

### 3. Bot–Gateway Reassignment (no double sockets, no lost messages)

Changing a running bot's gateway is the tricky case. If you just re-pointed the routing,
the bot would end up pointing at a gateway where **no socket exists** — it would go
silently quiet. And if you opened the new socket before closing the old one, the account
would briefly have **two live sockets**, which duplicates messages and risks a ban.

So the move runs as a careful, ordered sequence:

1. **Close** the old socket first (never two sockets on one account).
2. **Open** the new socket on the target gateway.
3. Only after the new socket is healthy, **commit** the change: update the registry and
   switch live routing to the new gateway.

If opening the new socket fails, it **rolls back** — the old socket is reopened and
nothing is changed, so the bot keeps running where it was.

The brief window with no socket (between steps 1 and 2) is automatically backfilled: when
the new socket comes up it catches up on any messages that arrived during the gap.

### 4. Gateway Restart Recovery (auto-reconnect)

Gateways are containers — they get restarted by deploys, crashes, or going idle. A restart
wipes their live sockets. When a gateway comes back up, it asks Fleet Manager **"which
bots should I be running?"** and gets back the list with each bot's credential, then
rebuilds every socket automatically — no operator action, no re-login.

Fleet Manager is the authoritative answer to that question, so a bot that was moved away
while the gateway was down does **not** get a stale socket resurrected, and a bot added
while it was down **is** picked up.

### 5. Background Reconciliation (interrupted moves + dead sockets)

A scheduled job runs **every 5 minutes** (cron `*/5 * * * *`) and, on each tick, runs two
sweeps that fix silent breakage without anyone watching:

- **Interrupted Reassignment** — *runs every 5 min; only acts on moves stuck > 2 min.* If a gateway
  move (feature 3) was cut off midway — say the process crashed between closing the old
  socket and committing — the sweep finds it and finishes it: it resumes from wherever it
  stopped, or rolls back if it can't complete. A healthy move finishes in seconds, so the
  2-minute threshold means a live move is never mistaken for a stuck one and double-driven,
  while a genuinely crashed one still heals within a tick.

- **Dead Gateway -> Platform Connection** — *runs every 5 min; acts immediately on any missing socket (no threshold).*
  A socket can die quietly (a network drop with no restart), leaving a bot that the registry
  thinks is `running` but that actually has no live channel. The sweep asks each gateway which
  bots it currently has live, compares that to what *should* be running, and reconnects any
  that are missing.

  It only reconnects genuinely-dead sockets. If a whole gateway can't be reached (it's down
  or restarting), the job leaves it alone — that gateway's own restart-recovery (feature 4)
  handles that case, so the two never fight.

---

## Monitoring (RYG traffic lights)

The `/ui` **Monitoring** tab shows **four** traffic lights per bot. Two are
**authoritative** (they read control-plane truth), two are **derived** (observed,
last-known signal — not a live probe). The colour vocabulary is the same everywhere:

| Colour | Meaning |
|---|---|
| Green | ok / healthy |
| Yellow | processing / in-flight (transient) |
| Red | degraded / failed |
| Gray | unknown / idle (no signal) |

**Data sources:** lights #1–#2 come from D1 (`bots.status`, `gateways.status`) plus a
live DO `stats()` reachability check. Lights #3–#4 are computed from `GET /monitor`
(`fleetOutboxHealth`, `message-repo.ts`) — a single `GROUP BY bot_id` query over the
shared `message` table. The delivery FSM is `PENDING → SENDING → SENT | DLQ`; inbound
rows carry the sentinel `RECEIVED`.

> **Teaching-build note.** The lights and the `delivery_state` FSM below describe the
> control-plane monitor as-is. The reduced `bot-fleet` delivers replies best-effort
> *inline* (no outbox drainer, so no `SENDING`/`DLQ` transitions), and outbound rows are
> written with the default `PENDING`. So in this build lights #3–#4 will read green once
> the gateway stamps a send and otherwise sit yellow — the richer states are wired but
> rarely exercised.

### 1. Bot — lifecycle (AUTHORITATIVE)
Source: D1 `bots.status` + a live DO reachability probe (`botLight`, `ui/routes.ts:536`).
The probe:

- FM calls `GET /bots/:id/stats` over the `BOT_FLEET` service binding (`bot-runtime.ts:76`).
- bot-fleet runs `BOT_FLEET_DO.getByName(botId).stats()` (`control-routes.ts:76`) — the DO RPC round-trip *is* the liveness signal (it forces the instance to materialise and answer).
- RPC succeeds → alive (green); throws → `stats.error` → red ("running but DO unreachable").

| Colour | Condition |
|---|---|
| Green | `status = running` **and** the DO is reachable |
| Yellow | `status = provisioning` (starting up) |
| Red | `status = failed` **or** `status = running` but the DO is unreachable (`stats.error`) → degraded |
| Gray | any other lifecycle state (e.g. `stopped`) |

### 2. Gateway — health (AUTHORITATIVE)
Container health, read from `gateways.last_probe_health` (`gwLight`, `ui/routes.ts`).
Separate from `status`, which is membership (does this gateway accept pins).

- **Signal:** the 5-min sweep probes each gateway via `GET /connections` (returns `{ ok, connected: [botIds…] }`) and stores the derived health. Gateways with no running bots are not probed.
- **Staleness:** a probe older than 3 ticks (or never taken) shows gray.
- **Cordon:** a fresh `degraded` gateway is excluded from the provisioning roster (`listActiveIds`) so no bot is placed on a down container. Only a fresh, explicit `degraded` excludes; `null` (never probed) and `inactive` stay eligible, and a stale `degraded` fails open.

| Colour | State | Condition (from the last fresh probe) |
|---|---|---|
| Green | active | `ok:true` **and** ≥1 live socket (`connected` non-empty) |
| Yellow | inactive | `ok:true` **and** zero live sockets (`connected: []`) — container up but channels dark |
| Red | degraded | probe **unreachable** / non-2xx; **or** gateway not in the roster (removed); **or** any other `status` |
| Gray | — | no recent probe (stale or never probed) |

### 3. Bot → GW comms — delivery (DERIVED)
Source: the **latest** message's `delivery_state` (`lastState`), gated by the upstream
lights (`botToGwLight`, `ui/routes.ts:559`). The source:

- FM calls `GET /monitor` → `fleetOutboxHealth` (`message-repo.ts`): one Postgres `GROUP BY bot_id` query over the shared `message` table, via Hyperdrive.
- `lastState` = `(array_agg(delivery_state ORDER BY id DESC))[1]` — the newest message either direction. No live socket probe; it's the last observed delivery state.

| Colour | Condition |
|---|---|
| Green | latest = `SENT` **and** both Bot (#1) and Gateway (#2) are green |
| Yellow | latest = `RECEIVED` / `PENDING` / `SENDING` (awaiting reply / in flight); **or** latest = `SENT` but bot/gateway not both green |
| Red | latest = `DLQ` (dead-lettered); **or** Bot (#1) is red; **or** Gateway (#2) is red (the path can't be healthy if an upstream hop is down) |
| Gray | no messages yet |

### 4. GW → Platform comms — last send (DERIVED, "as of last try")
Source: the most recent **outbound** send state (`lastSendState`) (`gwToPlatformLight`,
`ui/routes.ts:575`). The source:

- Same `GET /monitor` → `fleetOutboxHealth` query as #3, same `message` table over Hyperdrive.
- `lastSendState` = the same `array_agg` `FILTER (WHERE from_me)` — the newest *outbound* row only. Outcome of the last send attempt, not current socket liveness (see caveat below).

| Colour | Condition |
|---|---|
| Green | last outbound = `SENT` (reached the platform) |
| Yellow | last outbound = `PENDING` / `SENDING` (send in progress) |
| Red | last outbound = `DLQ` (last send to the platform failed) |
| Gray | nothing sent yet |

> **Honesty caveat:** light #4 is **not** a live MTProto socket probe — it reflects the
> outcome of the *last delivery attempt*, not current socket liveness. So a bot that is
> idle but whose socket silently died can still read green here until the next send. A
> truly live `GW → platform` probe (via the container's `GET /connection/status`) has
> been deferred — it is left for TutorBot to decide whether such active probing could itself
> contribute to account banning. The authoritative dead-socket healing for that case is
> the connection health sweep (core feature 5).

---

## How it fits with the other services

```
        operator / UI
             │  HTTP
             ▼
     ┌───────────────┐   start / stop / move a bot        ┌────────────┐
     │ Fleet Manager │ ─────────────────────────────────▶ │  bot-fleet │  (reply loops)
     │  (this app)   │                                     └────────────┘
     │               │   open / close a socket,           ┌────────────┐
     │   registry    │ ─── ask "which sockets are live?" ─▶│  gateways  │  (live sockets)
     └───────────────┘                                     └────────────┘
             ▲                                                   │
             └───── on restart: "which bots should I run?" ──────┘
```

- **Fleet Manager → bot-fleet:** start / stop a bot's reply loop and switch which gateway
  it routes to.
- **Fleet Manager → gateways:** open a socket, close a socket, and ask which sockets are
  currently live.
- **gateways → Fleet Manager:** when a gateway restarts, *it* asks Fleet Manager for its
  recovery list (Fleet Manager answers with the bots it should be running). The gateway
  pulls this — Fleet Manager does not push it.

The login credential only ever travels from Fleet Manager to the gateway (where the socket
lives). It never rides through the bot-fleet reply path, and it is never logged.

---

## Running it

```bash
# type-check
pnpm --dir apps/fleet-manager typecheck

# tests
pnpm --dir apps/fleet-manager test

# deploy (staging) — run from the repo root
pnpm --dir apps/fleet-manager exec wrangler deploy --env staging

# apply registry migrations (staging)
pnpm --dir apps/fleet-manager exec wrangler d1 migrations apply DB --remote --env staging

# tail live logs (staging) — streams the worker's structured logs
pnpm --dir apps/fleet-manager exec wrangler tail --env staging

# tail with a filter (e.g. only errors, or pretty output)
pnpm --dir apps/fleet-manager exec wrangler tail --env staging --status error
pnpm --dir apps/fleet-manager exec wrangler tail --env staging --format pretty
```

Configuration (service bindings, database, the self-healing schedule) lives in
`wrangler.jsonc`.
