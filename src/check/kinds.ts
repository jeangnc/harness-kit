import type { InstalledIndex } from "../installed.js";
import type { LocalIds } from "../layout/index.js";

export interface KindConfig {
  readonly noun: string;
  readonly internalMissingHint: string;
  readonly externalMissingHint: string;
  readonly malformedHint: string;
  readonly haystack: ReadonlySet<string>;
  readonly localPlugins: ReadonlySet<string>;
}

export const REFERENCE_PREFIXES = ["skill", "command", "agent"] as const;
export type ReferencePrefix = (typeof REFERENCE_PREFIXES)[number];

interface KindShape {
  readonly local: (ids: LocalIds) => ReadonlySet<string>;
  readonly installed: (index: InstalledIndex) => ReadonlySet<string>;
}

const KIND_SHAPES: Readonly<Record<ReferencePrefix, KindShape>> = {
  skill: {
    local: (ids) => ids.skills,
    installed: (index) => new Set(index.skills.keys()),
  },
  command: {
    local: (ids) => ids.commands,
    installed: (index) => new Set(index.commands.keys()),
  },
  agent: {
    local: (ids) => ids.agents,
    installed: (index) => new Set(index.agents.keys()),
  },
};

function malformedHint(prefix: ReferencePrefix): string {
  return `expected \`{{${prefix}:<plugin>:<${prefix}>}}\` in kebab-case`;
}

export function unifiedKindConfigs(
  local: LocalIds,
  installed: InstalledIndex,
  localPlugins: ReadonlySet<string>,
): ReadonlyMap<string, KindConfig> {
  const configs = new Map<string, KindConfig>();
  for (const prefix of REFERENCE_PREFIXES) {
    const shape = KIND_SHAPES[prefix];
    const haystack = new Set<string>();
    for (const id of shape.local(local)) haystack.add(id);
    for (const id of shape.installed(installed)) haystack.add(id);
    configs.set(prefix, {
      noun: prefix,
      internalMissingHint: "not found in this marketplace",
      externalMissingHint: "not found among installed plugins",
      malformedHint: malformedHint(prefix),
      haystack,
      localPlugins,
    });
  }
  return configs;
}
