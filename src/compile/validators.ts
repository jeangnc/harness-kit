import { FQ_ID } from "../ids.js";
import type { ValidatorRegistry } from "../placeholders/index.js";
import type { Companion } from "../skill/index.js";
import type { LocalIds } from "../layout/index.js";

import { COMPANIONS_PREFIX, renderCompanions } from "./frontmatter.js";

export interface OwningPlugin {
  readonly name: string;
  readonly dependencies: ReadonlySet<string>;
}

export function buildRegistry(
  companions: readonly Companion[] | undefined,
  localIds: LocalIds,
  existingRefs: ReadonlySet<string>,
  skillDir: string,
  owner: OwningPlugin,
): ValidatorRegistry {
  return {
    skill: (value) => {
      if (value === null) return { ok: false, error: "expected `{{skill:<plugin>:<name>}}`" };
      if (!FQ_ID.test(value)) {
        return {
          ok: false,
          error: `skill id "${value}" must match <plugin>:<skill> (kebab-case)`,
        };
      }
      if (!localIds.skills.has(value)) {
        return { ok: false, error: `unknown skill id "${value}" — not a local skill` };
      }
      const crossPlugin = crossPluginViolation(value, owner);
      if (crossPlugin) return { ok: false, error: crossPlugin };
      return { ok: true, rendered: `\`${value}\`` };
    },
    command: (value) => {
      if (value === null) return { ok: false, error: "expected `{{command:<plugin>:<command>}}`" };
      if (!FQ_ID.test(value)) {
        return {
          ok: false,
          error: `command id "${value}" must match <plugin>:<command> (kebab-case)`,
        };
      }
      if (!localIds.commands.has(value)) {
        return { ok: false, error: `unknown command id "${value}" — not a local command` };
      }
      const crossPlugin = crossPluginViolation(value, owner);
      if (crossPlugin) return { ok: false, error: crossPlugin };
      return { ok: true, rendered: `\`/${value}\`` };
    },
    agent: (value) => {
      if (value === null) return { ok: false, error: "expected `{{agent:<plugin>:<agent>}}`" };
      if (!FQ_ID.test(value)) {
        return {
          ok: false,
          error: `agent id "${value}" must match <plugin>:<agent> (kebab-case)`,
        };
      }
      if (!localIds.agents.has(value)) {
        return { ok: false, error: `unknown agent id "${value}" — not a local agent` };
      }
      const crossPlugin = crossPluginViolation(value, owner);
      if (crossPlugin) return { ok: false, error: crossPlugin };
      return { ok: true, rendered: `\`${bareName(value)}\`` };
    },
    ext: (value) => {
      if (value === null) return { ok: false, error: "expected `{{ext:<plugin>:<skill>}}`" };
      if (!FQ_ID.test(value)) {
        return { ok: false, error: `ext id "${value}" must match <plugin>:<skill> (kebab-case)` };
      }
      return { ok: true, rendered: `\`${value}\`` };
    },
    "ext-command": (value) => {
      if (value === null) {
        return { ok: false, error: "expected `{{ext-command:<plugin>:<command>}}`" };
      }
      if (!FQ_ID.test(value)) {
        return {
          ok: false,
          error: `ext-command id "${value}" must match <plugin>:<command> (kebab-case)`,
        };
      }
      return { ok: true, rendered: `\`/${value}\`` };
    },
    "ext-agent": (value) => {
      if (value === null) return { ok: false, error: "expected `{{ext-agent:<plugin>:<agent>}}`" };
      if (!FQ_ID.test(value)) {
        return {
          ok: false,
          error: `ext-agent id "${value}" must match <plugin>:<agent> (kebab-case)`,
        };
      }
      return { ok: true, rendered: `\`${bareName(value)}\`` };
    },
    ref: (value) => {
      if (value === null) return { ok: false, error: "expected `{{ref:<relative-path>}}`" };
      if (!existingRefs.has(value)) {
        return { ok: false, error: `ref "${value}" not found relative to skill at ${skillDir}` };
      }
      return { ok: true, rendered: `\`${value}\`` };
    },
    [COMPANIONS_PREFIX]: () => {
      if (!companions?.length) {
        return { ok: false, error: "no companions are declared on this skill" };
      }
      return { ok: true, rendered: renderCompanions(companions) };
    },
  };
}

function bareName(id: string): string {
  const idx = id.indexOf(":");
  return idx === -1 ? id : id.slice(idx + 1);
}

function crossPluginViolation(id: string, owner: OwningPlugin): string | null {
  const idx = id.indexOf(":");
  if (idx === -1) return null;
  const otherPlugin = id.slice(0, idx);
  if (otherPlugin === owner.name) return null;
  if (owner.dependencies.has(otherPlugin)) return null;
  return `cross-plugin reference to "${otherPlugin}" requires "${otherPlugin}" in ${owner.name}'s dependencies`;
}
