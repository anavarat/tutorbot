# TutorBot Bot Fleet

A Cloudflare-edge take on an always-on bot fleet, reworked as a **teaching build**.
Instead of one long-lived pod per bot, **each bot is a hibernating Durable Object**
(Agents SDK) that wakes on a fixed interval, polls Postgres for new messages, produces a
reply, and hands it to a **Platform Gateway** for delivery over a real **Telegram
(MTProto)** socket. Idle bots cost ~\$0 — they sleep between wakes and only bill while
running.

> **What this teaches (and what it deliberately leaves out).** The architecture is real:
> a control plane, a fleet of hibernating per-bot actors, and a socket-holding gateway,
> all wired with Durable Objects, Hyperdrive, service bindings, and a container. The
> *intelligence* is stubbed out on purpose — replies are deterministic, per-persona
> **canned lines** (no model call), and the human-like cadence, durable reply pipeline,
> and retry/dead-letter machinery have been removed. Read it to learn the **shape** of a
> stateful edge system, not to run a production bot.

Each app also has its own README with the deep detail:

- [`apps/bot-fleet/README.md`](apps/bot-fleet/README.md) — the data plane (the per-bot poll loop).
- [`apps/fleet-manager/README.md`](apps/fleet-manager/README.md) — the control plane (registry, provisioning, reconciliation).
- [`apps/platform-gateway/README.md`](apps/platform-gateway/README.md) — the channel edge (worker router + Node container, sockets, recovery).

## Architecture

Three planes:

| Plane | Component | Role |
|---|---|---|
| Control | `fleet-manager` (Worker + D1) | Source of truth for which **bots** and **gateways** exist. Provisions/starts/stops bots; provisions/reaps gateways; persona picker; reconciliation; `/ui`. |
| Data (compute) | `bot-fleet` (Worker) hosting `BotFleetDO` | One Durable Object per bot. Owns per-bot run-state and the fixed-interval poll loop. |
| Data (edge) | `platform-gateway` (Worker + Container) | Routes a `gatewayId` to a container; the container holds the live MTProto sockets, writes inbound to Postgres, and sends replies. |

Shared state: a **Supabase Postgres** database — source of truth for messages — reached via
**Hyperdrive** from the bot-fleet and fleet-manager Workers, and via a direct `pg.Pool`
from the gateway container.

Internal Worker-to-Worker calls use **service bindings** (bypass Cloudflare Access + the
public edge). The bot addresses its gateway over the `GATEWAY` binding; the gateway
resolves `botId -> gatewayId` and pulls its recovery roster from the fleet-manager over
the `FLEET_MANAGER` binding.

```
Operator --HTTPS--> Access --> fleet-manager (D1: bots, gateways)
                            +-> platform-gateway --> GatewayContainer --> Telegram + Postgres
BotFleetDO --Hyperdrive--> Postgres   --canned reply-->   --GATEWAY binding--> /outbound
```

## Monorepo layout

pnpm workspaces (`apps/*`, `apps/platform-gateway/*`, `packages/*`):

```
apps/
  bot-fleet/               Worker hosting BotFleetDO (Agents SDK)
  fleet-manager/           Control-plane Worker + D1 registry + /ui
  platform-gateway/
    worker/                Gateway edge Worker (routing, roster, DSN transport, recovery DO)
    container/             Gateway container (live MTProto sockets via teleproto, pg.Pool)
packages/
  shared/                  Schema DDL, RPC contract, idempotency keys, observability
```

## The reply loop

Each `BotFleetDO` wake runs one poll (`pollOnce`, a self-scheduled callback) on a fixed
interval (`POLL_INTERVAL_SEC`, default 30s):

1. **Discover** — high-watermark scan of the bot's inbound (`message` rows with
   `from_me = false AND id > cursor`) over Hyperdrive.
2. **Reply** — for each new inbound message, produce a deterministic, per-persona
   **canned line** (`domain/reply/canned.ts`) — no model, no history, no prompt.
3. **Persist + deliver** — insert the reply as an outbound `message` row (`from_me = true`,
   dedup-safe on the reply key), then best-effort deliver it to the gateway. The row is the
   durable record; a delivery failure is logged and the loop keeps its cadence.
4. **Schedule** — advance the cursor and set the next wake, then hibernate ~free until it
   fires.

There is no separate outbox drainer, no retry/backoff track, no dead-letter queue, and no
active-hours cadence — those belong to the full data plane and are omitted here.

## Data model

Canonical schema lives in `packages/shared/src/schema.ts` (`MESSAGING_SCHEMA_DDL`),
applied by the container as a `CREATE IF NOT EXISTS` boot guard:

- `chat` — one row per conversation, unique on `(bot_id, channel, channel_chat_id)`.
- `message` — **unified** inbound + outbound in one table, keyed by
  `UNIQUE (bot_id, idempotency_key)`. `from_me` separates the bot's replies from inbound;
  `channel_message_id` is `NULL` until the gateway confirms delivery. The outbound rows
  also carry delivery-state columns (`delivery_state`, `attempts`, …) — retained for
  schema/insert compatibility but **not driven** in the teaching build.
- `gateway_update_state` — per-bot MTProto update cursor (`pts`/`qts`/…) so the gateway can
  replay messages missed while it was down.

The `persona` table (voice catalog: `name` / `subject` / `tone` / `greeting`) is created and
seeded by `apps/bot-fleet/scripts/seed-personas.mjs`, not by the boot-guard DDL.

The fleet-manager keeps its own **D1** registry (`fleet-registry`) as the control-plane
source of truth for which bots/gateways exist.

## Delivery & idempotency

Delivery is best-effort but still **dedup-safe** end to end:

- The bot writes the reply row with a deterministic **reply key** (derived from the inbound
  message it answers), so a re-run that re-inserts is a no-op on the `UNIQUE` constraint —
  the bot never double-replies.
- The gateway container sends the reply over the bot's **live Telegram socket** using a
  **stable MTProto `random_id`** derived from the reply key, then **stamps** the real
  returned message id onto the row — but only while `channel_message_id` is still `NULL`.
- A re-driven delivery re-uses the same `random_id` (Telegram de-dupes the wire send) and
  the stamp becomes a no-op, so a reply is never double-sent.

Inbound and reply keys are derived identically on both sides
(`packages/shared/src/keys.ts`), so the `UNIQUE` dedup and the stamp always match.

## Gateways & personas as first-class entities

Gateways are provisioned/reassigned/reaped from the control plane. The gateway Worker
fetches its active roster from the fleet-manager's D1 (cached in-isolate). A bot's
`gatewayId` can be swapped **live** without a restart (`reconfigure` on the DO); the move
runs as an ordered saga (close old socket -> open new -> commit) so an account never has
two live sockets. Personas are assigned at provision time and drive the reply voice.

## Resilience

- **Cold-start recovery** — a gateway container restart wipes its in-memory sockets, but
  each bot's session lives in **Durable Object storage**. On restart the DO pulls the
  authoritative roster from the fleet-manager (falling back to its own cache) and rebuilds
  every socket — no re-auth, no OTP.
- **Missed-message catch-up** — the container persists each bot's MTProto update cursor
  and, on reconnect, replays everything that arrived while it was down back through the
  normal inbound seam (idempotently).
- **Background reconciliation** — a fleet-manager cron sweep finishes interrupted moves and
  reconnects dead sockets without operator action.

## Develop, test, deploy

Requires Node + `pnpm@11`, and Docker for the gateway container image.

```bash
pnpm install
pnpm typecheck            # pnpm -r typecheck
pnpm test                 # pnpm -r --if-present test
pnpm lint

# Deploy (default/dev-local targets)
pnpm deploy:bot-fleet
pnpm deploy:fleet-manager
pnpm deploy:platform-gateway     # builds + pushes the container image (Docker required)

# Named environments use wrangler --env directly, e.g.
pnpm --dir apps/fleet-manager exec wrangler deploy --env staging
pnpm --dir apps/fleet-manager exec wrangler d1 migrations apply DB --remote --env staging
```

Seed the persona catalog into Supabase (dry-run first, then `--apply`):

```bash
node apps/bot-fleet/scripts/seed-personas.mjs
node apps/bot-fleet/scripts/seed-personas.mjs --apply
```

Provision and start a bot (behind Access — send a service token or use `/ui`):

```bash
curl -sX POST https://<fleet-manager-host>/bots \
  -H 'content-type: application/json' \
  -d '{"gatewayId":"gw-1","personaName":"Ada"}'
```

## Configuration

Bindings and vars live in each app's `wrangler.jsonc`:

- **bot-fleet** — `BOT_FLEET_DO` (Durable Object), `HYPERDRIVE` (Supabase pooler),
  `GATEWAY` service binding, and `POLL_INTERVAL_SEC`.
- **fleet-manager** — `DB` (D1 `fleet-registry`), `HYPERDRIVE` (persona picker),
  `GATEWAY` + `BOT_FLEET` service bindings, the reconciliation cron.
- **platform-gateway** — `GATEWAY_CONTAINER` (Container), `FLEET_MANAGER` service binding,
  `DB_PASSWORD` from the account **Secrets Store** plus the non-secret `DB_*` parts
  (pointed at Supabase), and the app-level `TELEGRAM_API_ID` / `TELEGRAM_API_HASH`
  per-Worker secrets. The Worker assembles the DSN and forwards it to the container **in
  the request body** (never a header/URL — invocation logs capture those in plaintext).

## Caveats

- Telegram sessions are **minted offline** (the container has no stdin for an OTP); the bot
  connects from a pre-minted StringSession. The app `api_hash` never reaches the container
  and is never persisted in DO storage.
- The container's `/outbox` buffer is **in-memory** (temp UI only, lost on restart); the
  durable truth is the Postgres `message` rows.
- **Postgres (Supabase) and Hyperdrive are shared** across dev/staging for now.
- `BotStats` (over RPC) reports `count` (poll wakes), `cursor`, `rowsTotal` — not a reply
  count; real replies are `message` rows with `from_me = true`.
