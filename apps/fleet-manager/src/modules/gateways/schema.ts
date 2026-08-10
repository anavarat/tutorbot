import { z } from "zod";

/**
 * POST /gateways request body, validated at the boundary (unknown fields
 * stripped). Mirrors bots/schema.ts.
 *
 * `gatewayId` is OPTIONAL: omit it to auto-allocate gw-N from the D1 counter
 * (symmetric with bot-N); supply one to name it explicitly (e.g. "gw-eu-1").
 * `label` is an optional human-friendly description.
 */
export const provisionGatewaySchema = z.object({
  gatewayId: z.string().min(1).optional(),
  label: z.string().min(1).optional(),
});

export type ProvisionGatewayInput = z.infer<typeof provisionGatewaySchema>;
