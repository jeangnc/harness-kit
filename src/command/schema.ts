import { z } from "zod";

import { description, kebabName } from "../schema-primitives.js";

export const CommandSchema = z
  .object({
    name: kebabName,
    description,
    "argument-hint": z.string().min(1).optional(),
    "allowed-tools": z.union([z.string().min(1), z.array(z.string().min(1))]).optional(),
    model: z.string().min(1).optional(),
  })
  .strict();

export type Command = z.infer<typeof CommandSchema>;

export function defineCommand(command: Command): Command {
  return CommandSchema.parse(command);
}
