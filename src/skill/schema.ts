import { z } from "zod";

import { description, kebabName, singleLineString } from "../schema-primitives.js";

const RESERVED_COMPANION_FILENAMES: ReadonlySet<string> = new Set(["body.md", "SKILL.md"]);

export function isReservedCompanionFilename(name: string): boolean {
  return RESERVED_COMPANION_FILENAMES.has(name);
}

export const CompanionSchema = z.object({
  file: z
    .string()
    .regex(/^[a-z0-9-]+\.md$/, "companion file must be a kebab-case .md filename")
    .refine(
      (f) => !isReservedCompanionFilename(f),
      (f) => ({ message: `"${f}" is reserved and cannot be used as a companion filename` }),
    ),
  summary: singleLineString("companion summary"),
});

export type Companion = z.infer<typeof CompanionSchema>;

export const SkillSchema = z
  .object({
    name: kebabName,
    description,
    companions: z
      .array(CompanionSchema)
      .optional()
      .refine(
        (arr) => !arr || new Set(arr.map((c) => c.file)).size === arr.length,
        "companion files must be unique",
      ),
  })
  .strict();

export type Skill = z.infer<typeof SkillSchema>;

export function defineSkill(skill: Skill): Skill {
  return SkillSchema.parse(skill);
}
