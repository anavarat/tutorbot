/**
 * OpenAPI 3.1 spec for the fleet-manager WORKER HTTP surface.
 *
 * fleet-manager is the CONTROL PLANE: a D1-backed Worker (no Durable Object of
 * its own) that owns the bot + gateway registries and orchestrates BotFleetDO
 * lifecycle over a cross-script DO stub. This spec documents its full HTTP API
 * as actually implemented (the routes mounted in app.ts).
 *
 * Single source of truth for the served /openapi.yaml (see docs/routes.ts).
 */
export const OPENAPI_SPEC = `openapi: 3.1.0
info:
  title: fleet-manager (control plane)
  version: 0.0.0
  description: |
    fleet-manager is the CONTROL PLANE for the bot fleet. It is a D1-backed
    Worker (it has NO Durable Object of its own) that:

      - owns the D1 'bots' and 'gateways' registries (source of truth for which
        bots and gateways exist), and
      - orchestrates BotFleetDO lifecycle by holding a typed cross-script Durable
        Object stub and calling its RPC (start / reconfigure / stop / stats).

    ## State ownership

    | Concern                         | Owner                                  |
    |---------------------------------|----------------------------------------|
    | which bots/gateways exist       | fleet-manager D1                       |
    | live bot run-state (counters)   | BotFleetDO (read via stats RPC)        |
    | persona catalog                 | Supabase (read directly via HYPERDRIVE)|
    | gateway roster (for validation) | fleet-manager D1                       |

    ## Conventions

    - Success bodies vary per route (see each response). Most include ok: true.
    - Errors use a uniform envelope: { ok: false, error, ...extra } where extra
      carries route-specific context (issues, known, botId, count).
    - Any unsupported METHOD on a known path returns 405
      { ok: false, error: "method not allowed" }. Unknown paths return 404
      { ok: false, error: "not found" }.
servers:
  - url: /
    description: Current origin (the deployed fleet-manager Worker)
tags:
  - name: Bots
    description: Bot registry + lifecycle (provision, list, update, stop, remove)
  - name: Gateways
    description: Gateway registry + lifecycle (provision, list, reap)
  - name: Catalog
    description: Persona catalog discovery (proxied from bot-fleet)
  - name: System
    description: Help + web control panel
paths:
  /bots:
    get:
      tags: [Bots]
      operationId: listBots
      summary: List registry rows
      parameters:
        - name: live
          in: query
          required: false
          schema:
            type: string
            enum: ["1"]
          description: When "1", also fan out a stats RPC per bot and include it.
      responses:
        '200':
          description: Registry rows (with live stats when live=1).
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ListBotsResult'
    post:
      tags: [Bots]
      operationId: provisionBot
      summary: Provision + start a bot
      description: |
        Validates gatewayId against the roster, upserts the D1 registry row, then
        fires the DO start RPC. botId auto-allocates to bot-N when omitted.
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/ProvisionBotRequest'
      responses:
        '200':
          description: Provisioned and started.
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/BotStartOk'
        '400':
          description: Invalid body, or unknown gatewayId.
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Error'
        '409':
          description: Row written but the DO start failed.
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/BotStartFailed'
        '502':
          description: DO RPC threw (start could not be attempted cleanly).
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Error'
  /bots/{id}:
    parameters:
      - $ref: '#/components/parameters/BotId'
    get:
      tags: [Bots]
      operationId: getBot
      summary: One registry row + live stats
      responses:
        '200':
          description: Row plus live stats (or a stats error envelope).
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/GetBotOk'
        '404':
          description: No such bot.
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Error'
    patch:
      tags: [Bots]
      operationId: updateBot
      summary: Update a bot's gateway/persona mapping
      description: |
        At least one of gatewayId / personaName must be present. For a RUNNING
        bot a gateway-only change is applied LIVE (reconfigure, cursor preserved);
        a persona change forces a full restart. A non-running bot is updated in D1
        only. To force a fresh run WITHOUT a mapping change, use
        POST /bots/{id}/restart.
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/UpdateBotRequest'
      responses:
        '200':
          description: Mapping updated (see restarted/reconfigured flags).
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/BotUpdateOk'
        '400':
          description: Empty/invalid patch, or unknown gatewayId.
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Error'
        '404':
          description: No such bot.
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Error'
        '409':
          description: Restart after update failed.
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/BotStartFailed'
        '502':
          description: DO RPC threw.
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Error'
    delete:
      tags: [Bots]
      operationId: removeBot
      summary: Best-effort stop, then drop the registry row
      responses:
        '200':
          description: Removed.
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/BotRemoveOk'
        '404':
          description: No such bot.
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Error'
  /bots/{id}/stop:
    parameters:
      - $ref: '#/components/parameters/BotId'
    post:
      tags: [Bots]
      operationId: stopBot
      summary: Stop the DO loop + mark the row stopped
      responses:
        '200':
          description: Stopped.
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/BotStopOk'
        '404':
          description: No such bot.
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Error'
  /bots/{id}/restart:
    parameters:
      - $ref: '#/components/parameters/BotId'
    post:
      tags: [Bots]
      operationId: restartBot
      summary: Force a fresh run of a RUNNING bot (current mapping)
      description: >-
        Imperative sibling of /stop. Restarts the bot's DO run using its CURRENT
        mapping (gateway + persona) — cursor 0, counters reset, new poll window. It
        does NOT change the mapping (that is PATCH's job) and takes no body. Only a
        RUNNING bot can be restarted; a stopped bot is a 409.
      responses:
        '200':
          description: Restarted (restarted=true).
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/BotUpdateOk'
        '409':
          description: Bot is not running, or the restart's start() returned ok:false.
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Error'
        '404':
          description: No such bot.
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Error'
        '502':
          description: DO start() threw.
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Error'
  /gateways:
    get:
      tags: [Gateways]
      operationId: listGateways
      summary: List the gateway roster (D1 source of truth)
      responses:
        '200':
          description: Gateway rows.
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ListGatewaysOk'
    post:
      tags: [Gateways]
      operationId: provisionGateway
      summary: Provision a gateway
      description: gatewayId auto-allocates to gw-N when omitted.
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/ProvisionGatewayRequest'
      responses:
        '200':
          description: Provisioned.
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/GatewayOk'
        '400':
          description: Invalid body.
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Error'
  /gateways/{id}:
    parameters:
      - $ref: '#/components/parameters/GatewayId'
    get:
      tags: [Gateways]
      operationId: getGateway
      summary: One gateway row
      responses:
        '200':
          description: Gateway row.
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/GatewayOk'
        '404':
          description: No such gateway.
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Error'
    delete:
      tags: [Gateways]
      operationId: reapGateway
      summary: Reap a gateway (remove row + best-effort stop its container)
      parameters:
        - name: force
          in: query
          required: false
          schema:
            type: string
            enum: ["1"]
          description: When "1", bypass the pinned-bots guard.
      responses:
        '200':
          description: Reaped.
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/GatewayReapOk'
        '404':
          description: No such gateway.
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Error'
        '409':
          description: Bots still pinned (retry with force=1).
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Error'
  /personas:
    get:
      tags: [Catalog]
      operationId: listPersonas
      summary: Discover the persona catalog (read directly from Supabase via Hyperdrive)
      responses:
        '200':
          description: Persona names, sorted. Empty list on a transient DB blip (never 500s).
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/PersonasOk'
  /ui:
    get:
      tags: [System]
      operationId: controlPanel
      summary: Web control panel (provision + lifecycle)
      responses:
        '200':
          description: HTML control panel.
          content:
            text/html:
              schema:
                type: string
  /:
    get:
      tags: [System]
      operationId: help
      summary: Plain-text usage help
      responses:
        '200':
          description: Help text.
          content:
            text/plain:
              schema:
                type: string
components:
  parameters:
    BotId:
      name: id
      in: path
      required: true
      schema:
        type: string
      example: bot-1
    GatewayId:
      name: id
      in: path
      required: true
      schema:
        type: string
      example: gw-1
  schemas:
    BotRow:
      type: object
      required: [bot_id, gateway_id, persona_name, status, created_at, updated_at]
      properties:
        bot_id:
          type: string
          example: bot-1
        gateway_id:
          type: string
          example: gw-1
        persona_name:
          type: [string, "null"]
          description: Assigned persona display name, or null for the fallback prompt.
        status:
          type: string
          enum: [provisioning, running, stopped, failed]
        created_at:
          type: integer
          description: Epoch milliseconds.
        updated_at:
          type: integer
          description: Epoch milliseconds.
    GatewayRow:
      type: object
      required: [gateway_id, label, status, created_at, updated_at]
      properties:
        gateway_id:
          type: string
          example: gw-1
        label:
          type: [string, "null"]
        status:
          type: string
          enum: [active, draining, reaped]
        created_at:
          type: integer
        updated_at:
          type: integer
    StartResult:
      type: object
      required: [ok]
      properties:
        ok:
          type: boolean
        reason:
          type: string
        botId:
          type: [string, "null"]
        startedAt:
          type: integer
        nextAlarm:
          type: [integer, "null"]
    StopResult:
      type: object
      required: [ok, botId, count]
      properties:
        ok:
          type: boolean
          const: true
        botId:
          type: [string, "null"]
        count:
          type: integer
    BotStats:
      type: object
      description: RPC-serializable run-state counters snapshot from the DO.
      properties:
        botId:
          type: [string, "null"]
        count:
          type: integer
        cursor:
          type: integer
        rowsTotal:
          type: integer
        runMinutes:
          type: integer
        startedAt:
          type: [integer, "null"]
        lastTs:
          type: [integer, "null"]
        stoppedAt:
          type: [integer, "null"]
        lastDelayMs:
          type: [integer, "null"]
        nextAlarm:
          type: [integer, "null"]
        elapsedMin:
          type: [number, "null"]
    StatsOrError:
      oneOf:
        - $ref: '#/components/schemas/BotStats'
        - type: object
          required: [error]
          properties:
            error:
              type: string
    BotWithStats:
      allOf:
        - $ref: '#/components/schemas/BotRow'
        - type: object
          properties:
            stats:
              $ref: '#/components/schemas/StatsOrError'
    ProvisionBotRequest:
      type: object
      required: [gatewayId]
      properties:
        botId:
          type: string
          description: Explicit id; omit to auto-allocate bot-N.
        gatewayId:
          type: string
          minLength: 1
          example: gw-1
        personaName:
          type: string
          minLength: 1
          description: Persona display name; omit to reuse existing or fallback.
        runMinutes:
          type: number
          exclusiveMinimum: 0
        force:
          type: boolean
    UpdateBotRequest:
      type: object
      description: >-
        Declarative mapping update. At least one of gatewayId / personaName is
        required. To force a fresh run without a mapping change, use
        POST /bots/{id}/restart instead.
      minProperties: 1
      properties:
        gatewayId:
          type: string
          minLength: 1
        personaName:
          type: string
          minLength: 1
    ProvisionGatewayRequest:
      type: object
      properties:
        gatewayId:
          type: string
          minLength: 1
          description: Explicit id; omit to auto-allocate gw-N.
        label:
          type: string
          minLength: 1
    BotStartOk:
      type: object
      required: [ok, bot, start]
      properties:
        ok:
          type: boolean
          const: true
        bot:
          oneOf:
            - $ref: '#/components/schemas/BotRow'
            - type: "null"
        start:
          $ref: '#/components/schemas/StartResult'
    BotStartFailed:
      type: object
      required: [ok, bot, start]
      properties:
        ok:
          type: boolean
          const: false
        bot:
          oneOf:
            - $ref: '#/components/schemas/BotRow'
            - type: "null"
        start:
          $ref: '#/components/schemas/StartResult'
    BotUpdateOk:
      type: object
      required: [ok, bot, restarted]
      properties:
        ok:
          type: boolean
          const: true
        bot:
          oneOf:
            - $ref: '#/components/schemas/BotRow'
            - type: "null"
        restarted:
          type: boolean
        reconfigured:
          type: boolean
        start:
          $ref: '#/components/schemas/StartResult'
    GetBotOk:
      type: object
      required: [bot, stats]
      properties:
        bot:
          $ref: '#/components/schemas/BotRow'
        stats:
          $ref: '#/components/schemas/StatsOrError'
    BotStopOk:
      type: object
      required: [ok, botId, stop]
      properties:
        ok:
          type: boolean
          const: true
        botId:
          type: string
        stop:
          $ref: '#/components/schemas/StopResult'
    BotRemoveOk:
      type: object
      required: [ok, botId, deleted]
      properties:
        ok:
          type: boolean
          const: true
        botId:
          type: string
        deleted:
          type: boolean
          const: true
    ListBotsResult:
      type: object
      required: [count, bots]
      properties:
        count:
          type: integer
        bots:
          type: array
          items:
            $ref: '#/components/schemas/BotWithStats'
    ListGatewaysOk:
      type: object
      required: [ok, count, gateways]
      properties:
        ok:
          type: boolean
          const: true
        count:
          type: integer
        gateways:
          type: array
          items:
            $ref: '#/components/schemas/GatewayRow'
    GatewayOk:
      type: object
      required: [ok, gateway]
      properties:
        ok:
          type: boolean
          const: true
        gateway:
          $ref: '#/components/schemas/GatewayRow'
    GatewayReapOk:
      type: object
      required: [ok, gatewayId, deleted, containerStopped]
      properties:
        ok:
          type: boolean
          const: true
        gatewayId:
          type: string
        deleted:
          type: boolean
          const: true
        containerStopped:
          type: boolean
        stopError:
          type: string
    PersonasOk:
      type: object
      required: [ok, personas]
      properties:
        ok:
          type: boolean
          const: true
        personas:
          type: array
          items:
            type: string
    Error:
      type: object
      required: [ok, error]
      description: Uniform error envelope; extra keys vary by route.
      additionalProperties: true
      properties:
        ok:
          type: boolean
          const: false
        error:
          type: string
`;
