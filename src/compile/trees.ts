import type { LocalIds, ResolvedPlugin } from "../layout/index.js";
import {
  effectiveTree,
  formatOverlayError,
  sourceView,
  type EffectiveTree,
} from "../overlay/index.js";
import type { SourceView } from "../skill/index.js";

import { throwInvariantViolations } from "./discovery.js";

export interface TreeScope {
  readonly vendor: string;
  readonly registeredVendors: readonly string[];
}

export interface VendorWorkspace {
  readonly pluginTrees: ReadonlyMap<string, EffectiveTree>;
  readonly rootTrees: readonly EffectiveTree[];
  readonly localIds: LocalIds;
}

export interface WorkspaceSource {
  readonly plugins: readonly ResolvedPlugin[];
  readonly namedRoots: Readonly<Record<string, string>>;
}

export async function vendorWorkspace(
  source: WorkspaceSource,
  scope: TreeScope,
): Promise<VendorWorkspace> {
  const pluginTrees = new Map(
    await Promise.all(
      source.plugins.map(
        async (plugin) => [plugin.name, await vendorTree(plugin.pluginDir, scope)] as const,
      ),
    ),
  );
  const rootTrees = await Promise.all(
    Object.values(source.namedRoots).map(async (root) => vendorTree(root, scope)),
  );
  return { pluginTrees, rootTrees, localIds: localIdsIn(pluginTrees) };
}

export function workspaceView(workspace: VendorWorkspace, tree: EffectiveTree): SourceView {
  return sourceView([tree, ...workspace.rootTrees]);
}

export async function vendorTree(root: string, scope: TreeScope): Promise<EffectiveTree> {
  const tree = await effectiveTree({ root, ...scope });
  if (!tree.ok) throwInvariantViolations(root, tree.error.map(formatOverlayError));
  return tree.value;
}

const SKILL_ENTRY = /^skills\/([^/]+)\/SKILL\.md$/;
const COMMAND_ENTRY = /^commands\/([^/]+)\.md$/;
const AGENT_ENTRY = /^agents\/([^/]+)\.md$/;

function localIdsIn(pluginTrees: ReadonlyMap<string, EffectiveTree>): LocalIds {
  const idsMatching = (pattern: RegExp): ReadonlySet<string> =>
    new Set(
      [...pluginTrees].flatMap(([plugin, tree]) =>
        [...tree.files.keys()].flatMap((rel) => {
          const name = pattern.exec(rel)?.[1];
          return name === undefined ? [] : [`${plugin}:${name}`];
        }),
      ),
    );
  return {
    skills: idsMatching(SKILL_ENTRY),
    commands: idsMatching(COMMAND_ENTRY),
    agents: idsMatching(AGENT_ENTRY),
  };
}
