import { FQ_ID } from "../ids.js";
import type { Validator, ValidatorRegistry } from "../placeholders/index.js";
import type { Companion } from "../skill/index.js";
import type { InstalledIndex } from "../installed.js";
import type { LocalIds } from "../layout/index.js";
import { REFERENCE_PREFIXES, type ReferencePrefix } from "../check/kinds.js";

import { COMPANIONS_PREFIX, renderCompanions } from "./frontmatter.js";

interface KindResolution {
  readonly haystack: ReadonlySet<string>;
  readonly render: (id: string) => string;
}

export function buildRegistry(
  companions: readonly Companion[] | undefined,
  localIds: LocalIds,
  installedIndex: InstalledIndex,
  existingRefs: ReadonlySet<string>,
  skillDir: string,
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
    registry[prefix] = referenceValidator(prefix, resolutionFor(prefix, localIds, installedIndex));
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
        haystack: union(localIds.skills, installedIndex.skills.keys()),
      };
    case "command":
      return {
        render: (id) => `\`/${id}\``,
        haystack: union(localIds.commands, installedIndex.commands.keys()),
      };
    case "agent":
      return {
        render: (id) => `\`${id}\``,
        haystack: union(localIds.agents, installedIndex.agents.keys()),
      };
  }
}

function union(local: ReadonlySet<string>, installed: Iterable<string>): ReadonlySet<string> {
  const merged = new Set(local);
  for (const id of installed) merged.add(id);
  return merged;
}

function referenceValidator(prefix: ReferencePrefix, kind: KindResolution): Validator {
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
    if (kind.haystack.has(value)) {
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
