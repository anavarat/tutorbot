# Platform Gateway

The **channel edge** for the fleet. This is the one service that holds the **actual live
Telegram sockets**. When a bot needs to receive or send a real message, it happens here.

The gateway is two runtimes working as one:

| Layer | Runtime | Job |
|---|---|---|
| **Worker** | Cloudflare Worker (edge) | Stateless router + secret handler. Routes every request by `gatewayId` to the right container, injects the DB credential, and hosts the Durable Object that survives restarts. |
| **Container** | Node.js (stateful) | Holds the long-lived **MTProto sockets** (one per bot), receives inbound DMs, sends replies, and writes to the database. This is the only place `teleproto` (the Telegram SDK) is imported. |

A **gateway** is addressed by name (e.g. `gw-1`). That name is used verbatim as the
Durable Object instance name, and each DO fronts exactly one container. So "gateway `gw-1`"
= "the `gw-1` DO" = "the `gw-1` container" — one live host holding a set of sockets.

---

## The pieces it runs

| Piece | What it is | Where |
|---|---|---|
| **Gateway router** | Resolves `gatewayId` → container and forwards connect / disconnect / inbound / outbound / health. | Worker |
| **GatewayContainer (DO)** | Wraps the container. Persists each bot's session credential in **DO storage** (which outlives the container) and rebuilds every socket on cold start. | Worker |
| **DSN resolver** | Assembles the Postgres connection string from config + the Secrets Store password and injects it **per-request in the body** (never a header/URL). | Worker |
| **Connection service** | Connects a bot from a pre-minted session, proves liveness, and holds the live socket in an in-memory registry. | Container |
| **Telegram adapter** | The sole `teleproto` boundary: connect, receive, send, catch-up, reconnect. | Container |
| **Message store** | Writes inbound messages and stamps delivered replies in Postgres over the container's own pool. | Container |

---

## What it stores

- **Session credentials (DO storage).** For every bot the DO holds a *recoverable* session
  — the `apiId` plus the StringSession — durably in Durable Object storage. This is the
  key design point: the **container is ephemeral** (a deploy, crash, or idle-sleep wipes
  its in-memory sockets), but **DO storage survives**, so the gateway can rebuild its
  sockets after any restart. The real `api_hash` (the app secret) is **never** persisted
  here and never reaches the container.

- **Messages + update cursor (Postgres, shared with bot-fleet).** The container writes inbound
  DMs into the unified `message` table (`from_me = false`) and stamps the real channel
  message id onto a reply row when it's delivered. It also persists each bot's **MTProto
  update cursor** (`pts`/`qts`/…) so a restart can replay everything missed while down.

- **Live sockets (in-memory, container).** The actual authenticated sockets live only in
  the container's memory. They are deliberately *not* persisted — they are rebuilt from the
  durable session on cold start (see feature 4).

---

## HTTP API

Routes on the **Worker** (all keyed off a `gatewayId`, which selects the container):

```
GET  /gateways                        the active gateway roster (from Fleet Manager)
GET  /gateways/:id/health             liveness of one gateway's container
GET  /gateways/:id/connections        which bots currently hold a live socket on this gateway
POST /gateways/:id/stop               stop this gateway's container now (called on reap)

POST /connection/connect              bind a bot's session to a live Telegram socket   { gatewayId, botId, sessionCredential, apiId?, apiHash? }
POST /connection/disconnect           tear a bot's socket down                          { gatewayId, botId }

POST /inbound                         ingest an inbound message (writes to Postgres)
POST /outbound                        deliver a bot's reply over its live socket
GET  /outbox                          poll a bot's buffered replies (temp UI)

GET  /bot-gateway?botId=              resolve a botId → its home gatewayId (asks Fleet Manager)
GET  /docs                            the Worker's own API reference (Scalar)
GET  /container/docs                  the container's API reference, proxied through the Worker
```

Two secrets ride these routes and are handled with care: the **Postgres DSN** and the
**session credential**. Both travel in the request **body** (never a header or URL, which
invocation logs capture in plaintext) and are never logged.

---

## End-to-end at a glance

The whole flow in one picture: a stateless Worker routes every request by `gatewayId` to a
stateful container that holds the real Telegram sockets; sessions live in DO storage,
messages in Postgres.

Each core feature below opens with a high-level sequence diagram of its flow.

---

## Core features

### 1. Connect (bind a session to a live socket)

`POST /connection/connect` opens a bot's real Telegram socket inside the target container.
Before the socket is built, the **DO records the session in its own storage**. The container then:

1. Connects from the pre-minted StringSession — no OTP, because the session was minted
   offline.
2. **Verifies the session is actually authorized** (`connect()` succeeds even on a revoked
   session, so this check is mandatory), and proves liveness with `getMe`.
3. Registers the live socket, wires the inbound handler, and runs cold-start catch-up.

### 2. Inbound + Outbound (real messages)

- **Inbound:** every new DM on a live socket flows adapter → domain filter → Postgres as a
  `from_me = false` row, idempotent on the shared join key. The bot's own echoes and
  non-message updates are dropped. This is what bot-fleet later polls.
- **Outbound:** a reply routed here is sent over the bot's live socket, then the returned
  **real channel message id** is stamped onto the reply row in Postgres — the "delivered"
  truth bot-fleet's drainer relies on. Sends use a **stable random id** derived from the
  reply key, so a re-drive after a lost ack is de-duplicated by Telegram (no second DM)
  rather than sent twice.

### 3. Disconnect (reassignment detach)

`POST /connection/disconnect` is the mirror of connect. Before tearing the live socket
down, the DO **deletes that bot's session from its own storage** — otherwise the next cold
start would replay every stored session and resurrect a socket for a bot that has since
moved to another gateway, giving **two live sockets on one account** (duplicate messages,
ban risk). This is what makes Fleet Manager's careful bot-move sequence safe.

### 4. Cold-Start Recovery (rebuild every socket after a restart)

A container restart — deploy, crash, OOM, or idle-sleep — wipes its in-memory sockets while
the DO's storage survives. On restart the DO **pulls this gateway's roster from Fleet
Manager** (the authoritative source of "which bots should I run?"), converges its own cache
to it, and replays a connect for each bot — no re-auth, no OTP.

### 5. Missed-Message Catch-Up

The container persists each bot's MTProto **update cursor** to Postgres (throttled, best-effort,
only when messages flow — so idle bots write nothing). On reconnect it restores the cursor
and runs Telegram's `getDifference`, which **replays every message missed while the gateway
was down** back through the same inbound seam into Postgres — idempotently. This covers both a
cold start (feature 4) and any transient in-process socket drop.

### 6. One Socket per Account (auth_key safety)

Telegram allows exactly **one live connection per session (auth_key)**. Two sockets on the
same session at once ⇒ `406 AUTH_KEY_DUPLICATED` (and ban risk). Three safeguards hold the
invariant across restarts, redeploys and gradual rollouts:

- **Disconnect-before-connect** — a re-connect for a bot tears its prior socket down
  **before** opening the new one (same `botId` ⇒ same auth_key), so one instance never runs
  two sockets on one session.
- **Graceful drain on SIGTERM** — before the container exits it disconnects every live
  socket (time-boxed) so Telegram **frees each auth_key**, instead of orphaning connections
  that would collide with the successor instance.
- **Retry on `AUTH_KEY_DUPLICATED`** — during a rollout the outgoing and incoming instances
  overlap for a moment; the incoming connect retries with a short linear backoff (**up to 4
  attempts: 1.5s / 3s / 4.5s**) while the old socket drains. `session_unauthorized` is
  terminal (needs a re-mint) and is **never** retried.

This is the runtime counterpart to feature 3: disconnect deletes the *stored* session so a
future cold start won't resurrect a moved bot's socket; these safeguards make sure that even
during the overlap of a live redeploy, only one socket ever holds a given auth_key.

---

## How it fits with the other services

```
   ┌───────────────┐   open / close a socket,           ┌───────────────────────────────┐
   │ Fleet Manager │ ─── ask "which sockets are live?" ▶ │      Platform Gateway          │
   │  (control)    │                                     │  ┌──────────┐   ┌───────────┐  │
   └───────┬───────┘                                     │  │  Worker  │──▶│ Container │  │
           ▲                                             │  │ (router) │   │ (sockets) │  │
           │ on restart: "which bots should I run?"      │  └────┬─────┘   └─────┬─────┘  │
           └─────────────────────────────────────────── │       │DO storage     │        │
                                                         └───────┼───────────────┼────────┘
   ┌───────────┐   deliver a reply                              │               │
   │ Bot Fleet │ ───────────────────────────────────────────────┘               ▼
   └───────────┘                                                            ┌──────────┐
                                                                            │ Telegram │
                                                                            └──────────┘
                                                        writes inbound / stamps replies │
                                                                            ┌──────────┐
                                                                            │   Postgres   │
                                                                            └──────────┘
```

- **Fleet Manager → gateway:** open a socket, close a socket, and ask which sockets are
  currently live.
- **gateway → Fleet Manager:** on restart, *pull* the recovery roster; also resolve a
  `botId → gatewayId` on demand. (The gateway pulls; Fleet Manager never pushes.)
- **Bot Fleet → gateway:** deliver a reply for the account's live socket to send.
- **gateway → Postgres:** write inbound messages, stamp delivered replies, persist the update
  cursor.

The session credential only ever travels from Fleet Manager to this gateway, rides the
request body, is persisted only in DO storage (never the container, never the app secret),
and is never logged.

---

## Deployments & regions

### Named environments (one script per region)

The Worker `name` auto-suffixes per environment, so **each env is a separate deployed
worker script** — and therefore its own DO namespace + container application. Production
fans out to three regions for **operational isolation** (separate customer sets / blast
radius), *not* data sovereignty:

| Env | Worker | `placement.region` |
|---|---|---|
| `staging` | `tutorbot-platform-gateway-staging` | `aws:ap-southeast-2` (AU) |
| `us-production` | `tutorbot-platform-gateway-us-production` | `aws:us-east-1` |
| `uk-production` | `tutorbot-platform-gateway-uk-production` | `aws:eu-west-2` |
| `au-production` | `tutorbot-platform-gateway-au-production` | `aws:ap-southeast-2` |

`placement.region` pins **where the Worker runs**. The `GatewayContainer` (a DO-backed
container) is created near the Worker's first touch, so it lands **in-region
transitively** — no location hint is threaded into code. The hints are **best-effort**
placement, not a legal residency guarantee. (Container placement has no APAC region, so
the AU container falls back to Cloudflare-default placement.)

Each region binds its **own** Secrets Store + Postgres (regional `store_id` +
`TUTORBOT_DB_<REGION>_PRODUCTION_PASSWORD`), resolved by name at deploy time by CI. Regions never
share state and there are **no cross-region service bindings**.

---

## Running it

The Worker and container build and deploy together — a `wrangler deploy` builds the
container's Docker image and pushes it, so **Docker must be running**.

```bash
# type-check (worker + container are separate packages)
pnpm --dir apps/platform-gateway/worker    typecheck
pnpm --dir apps/platform-gateway/container typecheck

# tests
pnpm --dir apps/platform-gateway/worker    test
pnpm --dir apps/platform-gateway/container test

# deploy (staging) — run from the repo root; builds + pushes the container image
pnpm --dir apps/platform-gateway/worker exec wrangler deploy --env staging

# deploy a production region — one region at a time (each is its own worker script)
pnpm --dir apps/platform-gateway/worker exec wrangler deploy --env us-production
pnpm --dir apps/platform-gateway/worker exec wrangler deploy --env uk-production
pnpm --dir apps/platform-gateway/worker exec wrangler deploy --env au-production

# tail live logs — swap --env for the target (staging | us-production | uk-production | au-production)
pnpm --dir apps/platform-gateway/worker exec wrangler tail --env staging
pnpm --dir apps/platform-gateway/worker exec wrangler tail --env staging --status error
```

The **Postgres password** comes from the account Secrets Store (rotate = update the secret, no
redeploy). The **app-level MTProto creds** (`TELEGRAM_API_ID` / `TELEGRAM_API_HASH`) are
per-Worker secrets set out of band — and because each env is a **separate worker script**,
they must be set **once per env** (`staging`, `us-production`, `uk-production`,
`au-production`):

```bash
pnpm --dir apps/platform-gateway/worker exec wrangler secret put TELEGRAM_API_ID   --env staging
pnpm --dir apps/platform-gateway/worker exec wrangler secret put TELEGRAM_API_HASH --env staging
```

Configuration (the container definition, the Fleet Manager service binding, DO bindings,
Postgres parts, and the Secrets Store binding) lives in `worker/wrangler.jsonc`.
