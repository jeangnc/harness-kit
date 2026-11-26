import { z } from "zod";

import { FQ_ID } from "../ids.js";
import { description, kebabName } from "../schema-primitives.js";

const AuthorSchema = z
  .object({
    name: z.string().min(1),
    email: z.string().min(1).optional(),
    url: z.string().min(1).optional(),
  })
  .strict();

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

export const AGENT_PLUGINS_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";

const ExtensionBlockSchema = z.record(z.string().min(1), z.unknown());

export const PluginSchema = z
  .object({
    $schema: z.literal(AGENT_PLUGINS_SCHEMA),
    name: kebabName,
    version: z.string().min(1),
    description,
    author: AuthorSchema.optional(),
    homepage: z.string().min(1).optional(),
    repository: z.string().min(1).optional(),
    license: z.string().min(1).optional(),
    keywords: z.array(z.string().min(1)).optional(),
    extensions: z.record(z.string().min(1), ExtensionBlockSchema).optional(),
  })
  .strict();

export type Plugin = z.infer<typeof PluginSchema>;

export type ExtensionBlock = z.infer<typeof ExtensionBlockSchema>;

export const HarnessExtensionSchema = z
  .object({
    hookRequires: z.array(HookRequirementSchema).optional(),
  })
  .strict();

export type HarnessExtension = z.infer<typeof HarnessExtensionSchema>;

export const HARNESS_EXTENSION = "harness";

export function extensionBlock(plugin: Plugin, namespace: string): ExtensionBlock {
  return plugin.extensions?.[namespace] ?? {};
}

export function withoutExtensions(plugin: Plugin): Omit<Plugin, "$schema" | "extensions"> {
  const { $schema: _schema, extensions: _extensions, ...rest } = plugin;
  return rest;
}
