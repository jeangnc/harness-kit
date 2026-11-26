import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { formatZodIssues } from "../errors/index.js";
import { pathExists } from "../fs.js";
import {
  formatFrontmatterError,
  parseFrontmatter,
  type FrontmatterError,
} from "../parsing/index.js";
import { err, ok, type Result } from "../result.js";

import { SkillSchema, type Skill } from "./schema.js";

export interface LoadedSkill {
  readonly skill: Skill;
  readonly body: string;
  readonly skillFilePath: string;
  readonly skillDir: string;
  readonly bodyOffset: number;
}

export type LoadSkillError =
  | { readonly tag: "no-source"; readonly skillDir: string }
  | { readonly tag: "schema-violation"; readonly path: string; readonly issues: readonly string[] }
  | {
      readonly tag: "invalid-frontmatter";
      readonly path: string;
      readonly cause: FrontmatterError;
    };

export const SKILL_FILE = "SKILL.md";

export async function findSkillFile(skillDir: string): Promise<string | null> {
  const path = join(skillDir, SKILL_FILE);
  return (await pathExists(path)) ? path : null;
}

export async function loadSkill(skillDir: string): Promise<Result<LoadedSkill, LoadSkillError>> {
  const skillFilePath = await findSkillFile(skillDir);
  if (skillFilePath === null) return err({ tag: "no-source", skillDir });
  const raw = await readFile(skillFilePath, "utf8");
  const fm = parseFrontmatter(raw);
  if (!fm.ok) {
    return err({ tag: "invalid-frontmatter", path: skillFilePath, cause: fm.error });
  }
  const parsed = SkillSchema.safeParse(fm.value.data);
  if (!parsed.success) {
    return err({
      tag: "schema-violation",
      path: skillFilePath,
      issues: formatZodIssues(parsed.error),
    });
  }
  return ok({
    skill: parsed.data,
    body: fm.value.body,
    skillFilePath,
    skillDir,
    bodyOffset: fm.value.bodyOffset,
  });
}

export function formatLoadSkillError(error: LoadSkillError): readonly string[] {
  switch (error.tag) {
    case "no-source":
      return [`expected ${SKILL_FILE} at ${error.skillDir}`];
    case "schema-violation":
      return error.issues;
    case "invalid-frontmatter":
      return [formatFrontmatterError(error.cause)];
  }
}
