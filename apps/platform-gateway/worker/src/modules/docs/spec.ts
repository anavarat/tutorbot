/**
 * OpenAPI 3.1 spec for the platform-gateway WORKER (edge router) HTTP surface.
 *
 * This documents the PUBLIC edge tier only. The Worker is a stateless router: it
 * keys every message route off a gatewayId, which it uses verbatim as the
 * GatewayContainer Durable Object instance name, and forwards to the Node
 * container that owns the DB write. The container's own internal HTTP API has a
 * SEPARATE spec (apps/platform-gateway/container). The GatewayContainer DO's
 * shutdown is Durable Object RPC (not HTTP) and is therefore out of scope here.
 *
 * Single source of truth for the served /openapi.yaml (see docs/routes.ts).
 */
export const OPENAPI_SPEC = `openapi: 3.1.0
info:
  title: platform-gateway (edge router)
  version: 0.0.0
  description: |
    The platform-gateway WORKER is the stateless EDGE ROUTER of the messaging
    data plane. It has four responsibilities:

      1. Discovery/control: expose the active gateway roster (owned by
         fleet-manager D1), per-gateway health/stop, and the live connection set.
      2. Routing: resolve a botId to its home gatewayId (via fleet-manager).
      3. Message forwarding: route /outbound to the correct GatewayContainer
         (by name), which sends over the bot's live socket and owns the DB write.
      4. Connection lifecycle: bind / tear a bot's live channel session on a
         gateway container (/connection/connect, /connection/disconnect). These
         forward the secret session credential (and the Postgres DSN on connect) in
         the BODY to the named container, pass-through.

    ## Two tiers

    | Tier                     | Role                                             |
    |--------------------------|--------------------------------------------------|
    | CF Worker (this spec)    | Edge router; no DB; no persistent state          |
    | Node.js Container        | Holds the Postgres pool; persists + delivers (own spec) |

    Message routes are PASS-THROUGH: the Worker validates the JSON envelope,
    injects the Postgres DSN into the body (Option B transport), forwards to the
    named container, and returns the container's response verbatim. So the
    success body of /outbound is the CONTAINER's body (see the container spec).

    ## Errors

    Worker-originated errors use { ok: false, component: "worker", error: { code,
    message } } with code in { INVALID_REQUEST, GATEWAY_UNKNOWN,
    CONTAINER_REQUEST_FAILED }. Errors surfaced by the container downstream use
    the container envelope { ok: false, error } (a plain string).
servers:
  - url: /
    description: Current origin (the deployed platform-gateway Worker)
tags:
  - name: Discovery
    description: Gateway roster + per-gateway health + live connection set
  - name: Control
    description: Per-gateway container lifecycle
  - name: Routing
    description: botId to gatewayId resolution
  - name: Messaging
    description: Outbound reply forwarding to the container
  - name: Connections
    description: Bind / tear a bot's live channel session on a gateway container
  - name: System
    description: Worker health, container health proxy
paths:
  /gateways:
    get:
      tags: [Discovery]
      operationId: listGateways
      summary: Active gateway roster
      description: |
        The active gateway ids, fetched from fleet-manager (D1 source of truth)
        over the internal service binding and cached in-isolate. This is NOT a
        Cloudflare API — no API lists running containers.
      responses:
        '200':
          description: Active gateway ids.
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/GatewaysList'
  /gateways/{gatewayId}/health:
    parameters:
      - $ref: '#/components/parameters/GatewayId'
    get:
      tags: [Discovery]
      operationId: gatewayHealth
      summary: Liveness probe for one gateway container
      description: Proves name-to-container routing end-to-end; forwards to the container /health.
      responses:
        '200':
          description: Container health (forwarded).
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/HealthContainer'
        '404':
          description: gatewayId not in the roster.
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/WorkerError'
  /gateways/{gatewayId}/connections:
    parameters:
      - $ref: '#/components/parameters/GatewayId'
    get:
      tags: [Discovery]
      operationId: gatewayConnections
      summary: The live botId set on one gateway's container
      description: |
        Forwards (pass-through) to the container GET /connections — the botIds
        this gateway currently holds an open channel socket for. fleet-manager's
        connection-reconcile sweep diffs this against D1's RUNNING set to find
        dead sockets. No secret; plain forward.
      responses:
        '200':
          description: Live connection set (container response).
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ContainerConnectionsOk'
        '404':
          description: gatewayId not in the roster (code GATEWAY_UNKNOWN).
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/WorkerError'
  /gateways/{gatewayId}/stop:
    parameters:
      - $ref: '#/components/parameters/GatewayId'
    post:
      tags: [Control]
      operationId: stopGateway
      summary: Stop one gateway's container instance
      description: |
        Called by fleet-manager on reap so a container stops billing immediately
        instead of lingering until its idle window. Best-effort; does NOT
        roster-check (the gateway may already be gone from the roster).
      responses:
        '200':
          description: Stop requested.
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/WorkerStopOk'
        '502':
          description: Stop failed.
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/WorkerError'
  /bot-gateway:
    get:
      tags: [Routing]
      operationId: resolveBotGateway
      summary: Resolve a botId to its home gatewayId
      description: |
        Asks fleet-manager (which owns the bot-to-gateway mapping in D1) over the
        internal service binding. A not-yet-provisioned bot is a NORMAL state,
        surfaced as HTTP 200 with ok: false + reason: not_provisioned.
      parameters:
        - name: botId
          in: query
          required: true
          schema:
            type: string
          example: bot-1
      responses:
        '200':
          description: Resolved, or a normal not_provisioned result (both 200).
          content:
            application/json:
              schema:
                oneOf:
                  - $ref: '#/components/schemas/BotGatewayResolved'
                  - $ref: '#/components/schemas/BotGatewayNotProvisioned'
        '400':
          description: Missing botId (code INVALID_REQUEST).
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/WorkerError'
        '502':
          description: fleet-manager missing/unreachable/5xx (code CONTAINER_REQUEST_FAILED).
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/WorkerError'
  /outbound:
    post:
      tags: [Messaging]
      operationId: outbound
      summary: Route a bot's generated reply to its gateway container
      description: |
        Routed by body.gatewayId to the container /deliver, which SENDS to the
        channel then STAMPS the channel id onto the reply row. Pass-through
        response.
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/OutboundRequest'
      responses:
        '200':
          description: Delivered + stamped (container response).
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ContainerDeliverOk'
        '400':
          description: Non-JSON body (Worker), or missing fields (container).
          content:
            application/json:
              schema:
                oneOf:
                  - $ref: '#/components/schemas/WorkerError'
                  - $ref: '#/components/schemas/ContainerError'
        '404':
          description: Unknown gatewayId (code GATEWAY_UNKNOWN).
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/WorkerError'
        '503':
          description: Not connected, or channel send failed; the bot-fleet retry track re-drives.
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ContainerError'
        '500':
          description: Stamp (DB) failed (container envelope).
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ContainerError'
  /connection/connect:
    post:
      tags: [Connections]
      operationId: connectionConnect
      summary: Bind a bot's pre-minted session to a live channel client on its gateway
      description: |
        Routed by body.gatewayId to the container /connection/connect. The Worker
        injects the Postgres DSN into the body (the container CACHES it per bot so a
        later socket-driven inbound can persist without an HTTP request). The
        sessionCredential AND the DSN are BOTH secrets: they ride the body (never
        a header/URL) and are never logged. Pass-through response.
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/ConnectionConnectRequest'
      responses:
        '200':
          description: Connected; channel identity returned (container response).
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ContainerConnectOk'
        '400':
          description: Non-JSON body (Worker), or missing fields (container).
          content:
            application/json:
              schema:
                oneOf:
                  - $ref: '#/components/schemas/WorkerError'
                  - $ref: '#/components/schemas/ContainerError'
        '404':
          description: Unknown gatewayId (code GATEWAY_UNKNOWN).
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/WorkerError'
        '409':
          description: session_unauthorized — the StringSession is dead; re-mint required (container envelope).
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ContainerError'
        '500':
          description: No channel credentials available (container envelope).
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ContainerError'
        '502':
          description: Channel connect failed (container envelope).
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ContainerError'
  /connection/disconnect:
    post:
      tags: [Connections]
      operationId: connectionDisconnect
      summary: Tear a bot's live socket down on its gateway (reassignment DETACH)
      description: |
        Routed by body.gatewayId; the request passes THROUGH the GatewayContainer
        DO, whose fetch() DELETES the bot's stored credential before forwarding so
        a later cold-start can't resurrect the socket. No DSN, no secret in the
        body — plain forward. Idempotent: a not-connected bot is still a 200.
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/ConnectionDisconnectRequest'
      responses:
        '200':
          description: Disconnected (or already gone; container response).
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ContainerDisconnectOk'
        '400':
          description: Non-JSON body (Worker), or missing botId (container).
          content:
            application/json:
              schema:
                oneOf:
                  - $ref: '#/components/schemas/WorkerError'
                  - $ref: '#/components/schemas/ContainerError'
        '404':
          description: Unknown gatewayId (code GATEWAY_UNKNOWN).
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/WorkerError'
  /health:
    get:
      tags: [System]
      operationId: health
      summary: Worker health
      responses:
        '200':
          description: Worker is up.
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/HealthWorker'
  /container/health:
    get:
      tags: [System]
      operationId: containerHealthProxy
      summary: Proxy the DEFAULT container's health
      responses:
        '200':
          description: Container health (forwarded).
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/HealthContainer'
  /container/ready:
    get:
      tags: [System]
      operationId: containerReadyProxy
      summary: Proxy the DEFAULT container's readiness
      responses:
        '200':
          description: Container readiness (forwarded).
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/HealthContainer'
  /:
    get:
      tags: [System]
      operationId: root
      summary: Root (points at /health)
      responses:
        '404':
          description: Deliberate 404 directing callers to GET /health.
          content:
            application/json:
              schema:
                type: object
                properties:
                  ok:
                    type: boolean
                    const: false
                  component:
                    type: string
                  message:
                    type: string
components:
  parameters:
    GatewayId:
      name: gatewayId
      in: path
      required: true
      schema:
        type: string
      example: gw-1
  schemas:
    HealthWorker:
      type: object
      required: [ok, component, env, version]
      properties:
        ok:
          type: boolean
          const: true
        component:
          type: string
          const: worker
        env:
          type: string
        version:
          type: string
    HealthContainer:
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
    WorkerError:
      type: object
      required: [ok, component, error]
      properties:
        ok:
          type: boolean
          const: false
        component:
          type: string
          const: worker
        error:
          type: object
          required: [code, message]
          properties:
            code:
              type: string
              enum: [INVALID_REQUEST, GATEWAY_UNKNOWN, CONTAINER_REQUEST_FAILED]
            message:
              type: string
    ContainerError:
      type: object
      required: [ok, error]
      description: Error envelope forwarded from the container.
      properties:
        ok:
          type: boolean
          const: false
        error:
          type: string
    GatewaysList:
      type: object
      required: [ok, component, gateways]
      properties:
        ok:
          type: boolean
          const: true
        component:
          type: string
          const: worker
        gateways:
          type: array
          items:
            type: string
          example: ["gw-1", "gw-2"]
    WorkerStopOk:
      type: object
      required: [ok, component, gatewayId, stopped]
      properties:
        ok:
          type: boolean
          const: true
        component:
          type: string
          const: worker
        gatewayId:
          type: string
        stopped:
          type: boolean
          const: true
    BotGatewayResolved:
      type: object
      required: [ok, component, botId, gatewayId]
      properties:
        ok:
          type: boolean
          const: true
        component:
          type: string
          const: worker
        botId:
          type: string
        gatewayId:
          type: string
    BotGatewayNotProvisioned:
      type: object
      required: [ok, component, reason, botId]
      properties:
        ok:
          type: boolean
          const: false
        component:
          type: string
          const: worker
        reason:
          type: string
          const: not_provisioned
        botId:
          type: string
    OutboundRequest:
      type: object
      required: [gatewayId, botId, content, idempotencyKey]
      properties:
        gatewayId:
          type: string
        botId:
          type: string
        content:
          type: string
        idempotencyKey:
          type: string
          description: The reply key — routes the send + drives exactly-once dedup and the Postgres stamp.
    ContainerDeliverOk:
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
    ConnectionConnectRequest:
      type: object
      required: [gatewayId, botId, sessionCredential]
      properties:
        gatewayId:
          type: string
          example: gw-1
        botId:
          type: string
          example: bot-1
        sessionCredential:
          type: string
          description: SECRET — the bot's pre-minted StringSession. Rides the body; never logged.
        apiId:
          type: integer
          description: Per-bot MTProto api_id (anti-ban). Falls back to the app-level env pair when absent.
        apiHash:
          type: string
          description: SECRET — per-bot MTProto api_hash. Falls back to env when absent; never logged.
    ConnectionDisconnectRequest:
      type: object
      required: [gatewayId, botId]
      properties:
        gatewayId:
          type: string
          example: gw-1
        botId:
          type: string
          example: bot-1
    ContainerConnectOk:
      type: object
      required: [ok, botId, identity]
      description: Pass-through container /connection/connect success.
      properties:
        ok:
          type: boolean
          const: true
        botId:
          type: string
        identity:
          $ref: '#/components/schemas/ChannelIdentity'
    ContainerDisconnectOk:
      type: object
      required: [ok, botId, disconnected]
      description: Pass-through container /connection/disconnect result.
      properties:
        ok:
          type: boolean
          const: true
        botId:
          type: string
        disconnected:
          type: boolean
          description: True when a live socket was torn down; false when it was already gone.
    ContainerConnectionsOk:
      type: object
      required: [ok, connected]
      description: Pass-through container /connections — the live botId set.
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
`;
