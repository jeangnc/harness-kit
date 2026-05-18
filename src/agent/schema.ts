import { z } from "zod";

import { description, kebabName } from "../schema-primitives.js";

export const AgentSchema = z
  .object({
    name: kebabName,
    description,
    tools: z.union([z.string().min(1), z.array(z.string().min(1))]).optional(),
    model: z.string().min(1).optional(),
  })
  .strict();

export type Agent = z.infer<typeof AgentSchema>;

export function defineAgent(agent: Agent): Agent {
  return AgentSchema.parse(agent);
}
