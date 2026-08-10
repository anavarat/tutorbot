/**
 * OpenAPI 3.1 spec for the bot-fleet WORKER HTTP surface.
 *
 * SCOPE: bot-fleet is the DATA PLANE. Its Worker hosts the BotFleetDO class and
 * exposes: a worker-level utility route (ping-db) + the bot lifecycle
 * CONTROL routes (start / reconfigure / stop / stats) that fleet-manager calls over
 * its BOT_FLEET service binding. Each control route resolves the per-bot DO by name
 * internally and invokes its native method; the DO's result shapes are the
 * TypeScript contract in packages/shared/src/rpc.ts.
 *
 * Single source of truth for the served /openapi.yaml (see docs/routes.ts).
 */
export const OPENAPI_SPEC = `openapi: 3.1.0
info:
  title: bot-fleet (data plane)
  version: 0.0.0
  description: |
    bot-fleet is the DATA PLANE of the fleet. This Worker:

      1. Defines and hosts the BotFleetDO Durable Object class (the stateful bot
         actor: poll loop, cursor, outbox drain).
      2. Exposes a worker-level utility route (ping-db).
      3. Exposes the bot lifecycle CONTROL routes below.

    ## Control surface (HTTP)

    fleet-manager drives bot lifecycle by calling this Worker's control routes over
    its BOT_FLEET service binding — plain HTTP, the same transport it uses for the
    gateway. Each route resolves the per-bot DO by name and invokes its native
    method:

    | Route                         | Purpose                                          |
    |-------------------------------|--------------------------------------------------|
    | POST /bots/{botId}/start       | Start / force-restart the bot poll loop          |
    | POST /bots/{botId}/reconfigure | Live gateway swap (no restart, cursor preserved) |
    | POST /bots/{botId}/stop        | Stop the loop                                    |
    | GET  /bots/{botId}/stats       | Read run-state counters (cursor, counts, alarms) |

    A method's BUSINESS outcome (e.g. reconfigure ok:false "not running") is a 200;
    only a thrown DO error is a 500. The result shapes are the TypeScript contract
    BotFleetRpc in packages/shared/src/rpc.ts.

    ## Note on unmatched paths

    Any path/method not listed here returns HTTP 200 with a plain-text help
    string (bot-fleet deliberately never surfaces a 404).
servers:
  - url: /
    description: Current origin (the deployed bot-fleet Worker)
tags:
  - name: System
    description: Worker-level health / DB sanity (no Durable Object involved)
  - name: Control
    description: Bot lifecycle control (fleet-manager calls these over the BOT_FLEET binding)
paths:
  /ping-db:
    get:
      tags: [System]
      operationId: pingDb
      summary: Worker-level Hyperdrive to Supabase sanity check
      description: |
        Opens a Hyperdrive connection and counts rows in the message table. Does
        NOT touch any Durable Object (no DO active time is billed). Any HTTP
        method is accepted (method-agnostic), GET is documented as the canonical
        one.
      responses:
        '200':
          description: Database reachable; current message row count returned.
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/PingDbOk'
        '500':
          description: Database unreachable / query failed.
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Error'
  /bots/{botId}/start:
    post:
      tags: [Control]
      operationId: startBot
      summary: Start / force-restart a bot's poll loop
      parameters: [{ $ref: '#/components/parameters/BotId' }]
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [gatewayId]
              properties:
                gatewayId: { type: string, example: gw-1 }
                personaName: { type: string, example: Tanya Alexander }
                runMinutes: { type: integer, example: 90 }
                force: { type: boolean }
      responses:
        '200':
          description: Start result (ok=false is a valid business outcome).
          content:
            application/json:
              schema: { type: object, description: StartResult (see BotFleetRpc) }
        '400': { description: gatewayId missing }
        '500': { description: DO threw (infra failure) }
  /bots/{botId}/reconfigure:
    post:
      tags: [Control]
      operationId: reconfigureBot
      summary: Live gateway swap (no restart, cursor preserved)
      parameters: [{ $ref: '#/components/parameters/BotId' }]
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [gatewayId]
              properties:
                gatewayId: { type: string, example: gw-2 }
      responses:
        '200':
          description: Reconfigure result (ok=false e.g. "not running").
          content:
            application/json:
              schema: { type: object, description: ReconfigureResult (see BotFleetRpc) }
        '400': { description: gatewayId missing }
        '500': { description: DO threw (infra failure) }
  /bots/{botId}/stop:
    post:
      tags: [Control]
      operationId: stopBot
      summary: Stop a bot's poll loop
      parameters: [{ $ref: '#/components/parameters/BotId' }]
      responses:
        '200':
          description: Stop result.
          content:
            application/json:
              schema: { type: object, description: StopResult (see BotFleetRpc) }
        '500': { description: DO threw (infra failure) }
  /bots/{botId}/stats:
    get:
      tags: [Control]
      operationId: botStats
      summary: Read a bot's live run-state counters
      parameters: [{ $ref: '#/components/parameters/BotId' }]
      responses:
        '200':
          description: Counters snapshot.
          content:
            application/json:
              schema: { type: object, description: BotStats (see BotFleetRpc) }
        '500': { description: DO threw (infra failure) }
components:
  parameters:
    BotId:
      name: botId
      in: path
      required: true
      schema: { type: string }
      description: The bot's id (== its BotFleetDO instance name).
  schemas:
    PingDbOk:
      type: object
      required: [ok, messages]
      properties:
        ok:
          type: boolean
          const: true
        messages:
          type: integer
          description: Current row count of the message table.
          example: 212
    Error:
      type: object
      required: [ok, error]
      properties:
        ok:
          type: boolean
          const: false
        error:
          type: string
          description: Human-readable error message.
`;
