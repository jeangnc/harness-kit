import { z } from "zod";

import { PLUGIN_ID } from "./ids.js";

export const kebabName = z.string().min(1).regex(PLUGIN_ID, "name must be lowercase kebab-case");

export function singleLineString(field: string): z.ZodString | z.ZodEffects<z.ZodString, string> {
  return z
    .string()
    .min(1)
    .refine((s) => !s.includes("\n"), `${field} cannot contain newlines`);
}

export const description = z
  .string()
  .min(1)
  .max(1024)
  .refine((s) => !s.includes("\n"), "description cannot contain newlines");
