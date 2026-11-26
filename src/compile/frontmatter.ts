import { dump } from "js-yaml";

import { parsePlaceholders } from "../placeholders/index.js";
import type { Companion, Skill } from "../skill/index.js";

export const COMPANIONS_PREFIX = "companions";

export function renderFrontmatter(skill: Skill, description: string = skill.description): string {
  const lines = [`name: ${skill.name}`, `description: ${description}`];
  if (skill.companions?.length) {
    lines.push(dump({ companions: skill.companions }).trimEnd());
  }
  return `---\n${lines.join("\n")}\n---\n\n`;
}

export function renderCompanions(companions: readonly Companion[]): string {
  const bullets = companions.map((c) => `- \`${c.file}\` — ${c.summary}`).join("\n");
  return `## Companion files (read on demand)

${bullets}`;
}

export function checkCompanionsTokenParity(
  body: string,
  companions: readonly Companion[] | undefined,
): string[] {
  if (!companions?.length) return [];
  const hasToken = parsePlaceholders(body).some(
    (t) => t.prefix === COMPANIONS_PREFIX && t.value === null,
  );
  if (!hasToken) {
    return [`companions declared but body is missing the {{${COMPANIONS_PREFIX}}} placeholder`];
  }
  return [];
}
