/**
 * OpenAPI 3.1 spec for the platform-gateway CONTAINER (Node.js) internal HTTP API.
 *
 * SCOPE: this is an INTERNAL API. The container is never addressed directly by
 * external callers — the platform-gateway Worker routes a gatewayId to this
 * container instance (by Durable Object name) and forwards requests here. The
 * container owns the Postgres connection pool and performs the actual DB writes and
 * channel delivery. Documented for developers/operators, not as a public API.
 *
 * Single source of truth for the served /openapi.yaml (see docs/routes.ts).
 */
export const OPENAPI_SPEC = `openapi: 3.1.0
info:
  title: platform-gateway container (internal)
  version: 0.0.0
  description: |
    INTERNAL message-plane API of the platform-gateway Node.js CONTAINER. The
    edge Worker forwards here after routing a gatewayId to this container
    instance by name. The container owns the Postgres pg.Pool and is the channel
    edge (it SENDS to the channel and STAMPS delivery truth in Postgres).

    ## Not publicly reachable

    These routes are reached only via the Worker's internal container dispatch.
    There is no public origin for the container. The Worker proxies only
    /health and /ready externally.

    ## DSN transport (Option B)

    The DB route (/deliver) — and /connection/connect — receive the Postgres DSN in a
    request BODY field named __dbDsn, injected by the Worker from the account
    Secrets Store. It is carried in the body (never a header/URL) because
    Cloudflare invocation logs capture headers/URLs in plaintext. The container
    reads it, (re)builds its pool, and never logs it. /connection/connect does not
    itself write to Postgres, but CACHES the DSN per bot so a later socket-driven
    inbound (which arrives with no HTTP request) can still persist. Other routes
    never receive it.

    ## Errors

    Errors use a plain envelope: { ok: false, error } where error is a string.
servers:
  - url: /
    description: Container-local origin (internal; via the Worker's dispatch)
tags:
  - name: Connections
    description: Bind / tear a bot's live channel (MTProto) socket + probe the live set
  - name: Messaging
    description: Outbound reply delivery over the live socket
  - name: System
    description: Health / readiness
paths:
  /deliver:
    post:
      tags: [Messaging]
      operationId: deliver
      summary: Send a bot reply over the live socket and stamp delivery truth
      description: |
        (1) SENDS over the bot's live MTProto socket using a STABLE random_id
        derived from the reply key (Telegram de-dupes a re-drive => no second DM).
        (2) STAMPS the real channel id onto the reply row in Postgres (idempotent, IS
        NULL guard). Requires the idempotencyKey (reply key) and the __dbDsn body
        field.
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/DeliverRequest'
      responses:
        '200':
          description: Delivered over the live socket + stamped in Postgres.
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/DeliverOk'
        '400':
          description: Missing botId / content / idempotencyKey.
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Error'
        '503':
          description: Not connected, or channel send failed (retry track re-drives).
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Error'
        '500':
          description: Stamp (DB) failed.
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Error'
  /connection/connect:
    post:
      tags: [Connections]
      operationId: connect
      summary: Bind a bot's StringSession to a live channel client
      description: |
        Opens an MTProto socket for the bot from its pre-minted sessionCredential
        and registers it in the in-memory connection registry (ephemeral: lost on
        hibernate, rebuilt by cold-start recovery). Per-bot apiId/apiHash from the
        body win (anti-ban), else the app-level env pair. Caches the injected
        __dbDsn so a later socket-driven inbound can persist. The session
        credential and apiHash are secrets and are never logged.
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/ConnectRequest'
      responses:
        '200':
          description: Connected; the account's channel identity is returned.
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ConnectOk'
        '400':
          description: Missing botId / sessionCredential.
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Error'
        '409':
          description: session_unauthorized — the StringSession is dead; re-mint required.
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Error'
        '500':
          description: No channel credentials (none in body, env fallback unset).
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Error'
        '502':
          description: Channel connect failed.
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Error'
  /connection/disconnect:
    post:
      tags: [Connections]
      operationId: disconnect
      summary: Tear a bot's live socket down + drop it from the registry
      description: |
        Reassignment DETACH. Idempotent: a bot with no live socket still returns
        200 (the caller's saga treats "already gone" == "torn down"). Only botId
        is read; disconnect touches no credentials.
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/DisconnectRequest'
      responses:
        '200':
          description: Disconnected (or already gone).
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/DisconnectOk'
        '400':
          description: Missing botId.
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Error'
  /connections:
    get:
      tags: [Connections]
      operationId: connections
      summary: The live botId set (open sockets on this container)
      description: |
        The botIds this container currently holds an open channel socket for — a
        connection health probe. No body, no secrets. fleet-manager's reconcile
        sweep diffs this against D1's RUNNING set to find dead sockets.
      responses:
        '200':
          description: The live connection set.
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ConnectionsOk'
  /health:
    get:
      tags: [System]
      operationId: health
      summary: Container health
      responses:
        '200':
          description: Container is up.
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Health'
  /ready:
    get:
      tags: [System]
      operationId: ready
      summary: Container readiness (same payload as health)
      responses:
        '200':
          description: Container is ready.
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Health'
components:
  schemas:
    DeliverRequest:
      type: object
      required: [botId, content, idempotencyKey]
      properties:
        botId:
          type: string
        content:
          type: string
        idempotencyKey:
          type: string
          description: The reply key — routes the send + drives channel dedup and the Postgres delivery stamp.
        __dbDsn:
          type: string
          description: Internal DSN transport (injected by the Worker).
    DeliverOk:
      type: object
      required: [ok, botId]
      properties:
        ok:
          type: boolean
          const: true
        botId:
          type: string
        channelMessageId:
          type: string
          description: The real channel message id stamped onto the reply row.
        duplicate:
          type: boolean
          description: True when a deduped re-delivery.
    Health:
      type: object
      required: [ok, component, env, version]
      properties:
        ok:
          type: boolean
          const: true
        component:
          type: string
          const: container
        env:
          type: string
        version:
          type: string
    ConnectRequest:
      type: object
      required: [botId, sessionCredential]
      properties:
        botId:
          type: string
          example: bot-1
        sessionCredential:
          type: string
          description: SECRET — the bot's pre-minted StringSession. Never logged.
        apiId:
          type: integer
          description: Per-bot MTProto api_id (anti-ban); falls back to the env pair when absent.
        apiHash:
          type: string
          description: SECRET — per-bot MTProto api_hash; falls back to env when absent. Never logged.
        __dbDsn:
          type: string
          description: Internal DSN transport (injected by the Worker; cached per bot, not a domain field).
    DisconnectRequest:
      type: object
      required: [botId]
      properties:
        botId:
          type: string
          example: bot-1
    ConnectOk:
      type: object
      required: [ok, botId, identity]
      properties:
        ok:
          type: boolean
          const: true
        botId:
          type: string
        identity:
          $ref: '#/components/schemas/ChannelIdentity'
    DisconnectOk:
      type: object
      required: [ok, botId, disconnected]
      properties:
        ok:
          type: boolean
          const: true
        botId:
          type: string
        disconnected:
          type: boolean
          description: True when a live socket was torn down; false when it was already gone.
    ConnectionsOk:
      type: object
      required: [ok, connected]
      properties:
        ok:
          type: boolean
          const: true
        connected:
          type: array
          items:
            type: string
          example: ["bot-1", "bot-2"]
    ChannelIdentity:
      type: object
      required: [id]
      description: The connected account's channel identity (safe to log; no secret).
      properties:
        id:
          type: [string, integer]
        username:
          type: [string, "null"]
    Error:
      type: object
      required: [ok, error]
      properties:
        ok:
          type: boolean
          const: false
        error:
          type: string
`;
