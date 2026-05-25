import { z } from "zod";

import { FQ_ID } from "../ids.js";
import { description, kebabName } from "../schema-primitives.js";

const AuthorSchema = z
  .object({
    name: z.string().min(1),
    email: z.string().min(1).optional(),
    url: z.string().min(1).optional(),
  })
  .passthrough();

const DependencyEntrySchema = z.union([
  z.string().min(1),
  z
    .object({
      name: z.string().min(1),
      version: z.string().min(1).optional(),
      marketplace: z.string().min(1).optional(),
    })
    .passthrough(),
]);

export type DependencyEntry = z.infer<typeof DependencyEntrySchema>;

const SLUG_REF = z.string().min(1).regex(FQ_ID, "must match <plugin>:<name> kebab-case");

const HookRequirementBase = z.object({
  event: z.string().min(1),
  skill: SLUG_REF.optional(),
  command: SLUG_REF.optional(),
  agent: SLUG_REF.optional(),
});

export const HookRequirementSchema = HookRequirementBase.strict().superRefine((value, ctx) => {
  const slugs = [value.skill, value.command, value.agent].filter((s) => s !== undefined);
  if (slugs.length !== 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "exactly one of skill | command | agent must be set",
      path: [],
    });
  }
});

export type HookRequirement = z.infer<typeof HookRequirementSchema>;

export const PluginSchema = z
  .object({
    name: kebabName,
    version: z.string().min(1),
    description,
    author: AuthorSchema.optional(),
    homepage: z.string().min(1).optional(),
    repository: z.string().min(1).optional(),
    license: z.string().min(1).optional(),
    keywords: z.array(z.string().min(1)).optional(),
    dependencies: z.array(DependencyEntrySchema).optional(),
    commands: z.string().min(1).optional(),
    agents: z.string().min(1).optional(),
    hooks: z.string().min(1).optional(),
    hookRequires: z.array(HookRequirementSchema).optional(),
  })
  .passthrough();

export type Plugin = z.infer<typeof PluginSchema>;

export function definePlugin(plugin: Plugin): Plugin {
  return PluginSchema.parse(plugin);
}
