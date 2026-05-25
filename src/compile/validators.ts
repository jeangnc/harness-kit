import { FQ_ID } from "../ids.js";
import type { Validator, ValidatorRegistry } from "../placeholders/index.js";
import type { Companion } from "../skill/index.js";
import type { InstalledIndex } from "../installed.js";
import type { LocalIds } from "../layout/index.js";
import { REFERENCE_PREFIXES, type ReferencePrefix } from "../check/kinds.js";

import { COMPANIONS_PREFIX, renderCompanions } from "./frontmatter.js";

export type ReferenceOwner =
  | { readonly kind: "plugin"; readonly name: string; readonly dependencies: ReadonlySet<string> }
  | { readonly kind: "unrestricted"; readonly label: string };

interface KindResolution {
  readonly local: ReadonlySet<string>;
  readonly installed: ReadonlySet<string>;
  readonly render: (id: string) => string;
}

export function buildRegistry(
  companions: readonly Companion[] | undefined,
  localIds: LocalIds,
  installedIndex: InstalledIndex,
  existingRefs: ReadonlySet<string>,
  skillDir: string,
  owner: ReferenceOwner,
): ValidatorRegistry {
  const registry: Record<string, Validator> = {
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
  for (const prefix of REFERENCE_PREFIXES) {
    registry[prefix] = referenceValidator(
      prefix,
      resolutionFor(prefix, localIds, installedIndex),
      owner,
    );
  }
  return registry;
}

function resolutionFor(
  prefix: ReferencePrefix,
  localIds: LocalIds,
  installedIndex: InstalledIndex,
): KindResolution {
  switch (prefix) {
    case "skill":
      return {
        render: (id) => `\`${id}\``,
        local: localIds.skills,
        installed: new Set(installedIndex.skills.keys()),
      };
    case "command":
      return {
        render: (id) => `\`/${id}\``,
        local: localIds.commands,
        installed: new Set(installedIndex.commands.keys()),
      };
    case "agent":
      return {
        render: (id) => `\`${id}\``,
        local: localIds.agents,
        installed: new Set(installedIndex.agents.keys()),
      };
  }
}

function referenceValidator(
  prefix: ReferencePrefix,
  kind: KindResolution,
  owner: ReferenceOwner,
): Validator {
  return (value) => {
    if (value === null) {
      return { ok: false, error: `expected \`{{${prefix}:<plugin>:<${prefix}>}}\`` };
    }
    if (!FQ_ID.test(value)) {
      return {
        ok: false,
        error: `${prefix} id "${value}" must match <plugin>:<${prefix}> (kebab-case)`,
      };
    }
    if (kind.local.has(value)) {
      const crossPlugin = crossPluginViolation(value, owner);
      if (crossPlugin) return { ok: false, error: crossPlugin };
      return { ok: true, rendered: kind.render(value) };
    }
    if (kind.installed.has(value)) {
      return { ok: true, rendered: kind.render(value) };
    }
    return {
      ok: true,
      rendered: kind.render(value),
      warnings: [
        `${prefix} id "${value}" — not a local ${prefix} and not found among installed plugins`,
      ],
    };
  };
}

function crossPluginViolation(id: string, owner: ReferenceOwner): string | null {
  if (owner.kind === "unrestricted") return null;
  const idx = id.indexOf(":");
  if (idx === -1) return null;
  const otherPlugin = id.slice(0, idx);
  if (otherPlugin === owner.name) return null;
  if (owner.dependencies.has(otherPlugin)) return null;
  return `cross-plugin reference to "${otherPlugin}" requires "${otherPlugin}" in ${owner.name}'s dependencies`;
}
