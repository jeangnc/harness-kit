import { join } from "node:path";

import { compileTree, type WarningSink } from "./emit.js";
import { checkHookRootReads } from "./hooks.js";
import { throwInvariantViolations } from "./discovery.js";
import { SOURCE_PLUGIN_MANIFEST_JSON, SOURCE_PLUGIN_MANIFEST_TS } from "../layout/conventions.js";
import {
  collectLocalIds,
  loadLayout,
  type LayoutAdapter,
  type LocalIds,
  type ResolvedPlugin,
} from "../layout/index.js";
import {
  defaultSources,
  discoverInstalled,
  indexInstalled,
  type InstalledIndex,
  type PluginSource,
} from "../installed.js";
import type { HookRequirement } from "../plugin/index.js";
import type { Vendor } from "../vendor/schema.js";

export type { WarningSink } from "./emit.js";
export { loadAdapter };

export interface CompilePluginsOptions {
  readonly srcRoot: string;
  readonly outRoot: string;
  readonly vendors: readonly Vendor[];
  readonly onWarnings?: WarningSink;
  readonly sources?: readonly PluginSource[];
  readonly adapter?: LayoutAdapter;
  readonly localIds?: LocalIds;
  readonly installedIndex?: InstalledIndex;
}

export async function compilePlugins(options: CompilePluginsOptions): Promise<void> {
  const { srcRoot, outRoot, vendors } = options;
  if (vendors.length === 0) {
    throw new Error("compilePlugins requires at least one vendor");
  }
  const adapter = options.adapter ?? (await loadAdapter(srcRoot));
  const localIds = options.localIds ?? (await collectLocalIds(adapter));
  const installedIndex =
    options.installedIndex ??
    (await loadInstalledIndex(options.sources ?? defaultSources(vendors)));
  checkHookRequires(adapter, localIds);
  await checkHookRootReads(adapter);

  const skipRelPaths: ReadonlySet<string> = new Set(vendors.map((v) => v.pluginManifestPath));
  for (const vendor of vendors) {
    await vendor.emitMarketplaceManifest({ outRoot, marketplace: adapter.marketplace });
  }
  for (const plugin of adapter.plugins) {
    for (const vendor of vendors) {
      await emitPluginForVendor(plugin, vendor, {
        outRoot,
        localIds,
        installedIndex,
        skipRelPaths,
        ...(options.onWarnings ? { onWarnings: options.onWarnings } : {}),
      });
    }
  }
}

async function loadInstalledIndex(sources: readonly PluginSource[]): Promise<InstalledIndex> {
  const artifacts = await discoverInstalled(sources);
  return indexInstalled(artifacts);
}

async function loadAdapter(srcRoot: string): Promise<LayoutAdapter> {
  const result = await loadLayout(srcRoot);
  if (result.ok) return result.value;
  const error = result.error;
  switch (error.kind) {
    case "marketplace-missing":
      throw new Error(`marketplace.json not found at ${error.path}`);
    case "marketplace-invalid":
      return throwInvariantViolations(error.path, error.issues);
    case "plugin-missing":
      throw new Error(`plugin "${error.name}" not found at ${error.path}`);
    case "manifest-missing":
      return throwInvariantViolations(error.pluginDir, [
        `plugin "${error.name}": no ${SOURCE_PLUGIN_MANIFEST_TS} or ${SOURCE_PLUGIN_MANIFEST_JSON}`,
      ]);
    case "manifest-collision":
      return throwInvariantViolations(join(error.pluginDir, SOURCE_PLUGIN_MANIFEST_TS), [
        `both ${SOURCE_PLUGIN_MANIFEST_TS} and ${SOURCE_PLUGIN_MANIFEST_JSON} exist at ${error.pluginDir} — pick one`,
      ]);
    case "manifest-invalid":
      return throwInvariantViolations(error.path, error.issues);
    case "plugin-name-mismatch":
      return throwInvariantViolations(error.path, [
        `name "${error.manifestName}" does not match folder "${error.entryName}"`,
      ]);
  }
}

interface EmitPluginOptions {
  readonly outRoot: string;
  readonly localIds: LocalIds;
  readonly installedIndex: InstalledIndex;
  readonly skipRelPaths: ReadonlySet<string>;
  readonly onWarnings?: WarningSink;
}

async function emitPluginForVendor(
  plugin: ResolvedPlugin,
  vendor: Vendor,
  options: EmitPluginOptions,
): Promise<void> {
  const pluginOutDir = vendor.pluginOutDir(options.outRoot, plugin.name);
  await vendor.emitPluginManifest({ manifest: plugin.manifest, pluginOutDir });
  await compileTree({
    srcRoot: plugin.pluginDir,
    outRoot: pluginOutDir,
    localIds: options.localIds,
    installedIndex: options.installedIndex,
    skipRelPaths: options.skipRelPaths,
    ...(options.onWarnings ? { onWarnings: options.onWarnings } : {}),
  });
}

function checkHookRequires(adapter: LayoutAdapter, localIds: LocalIds): void {
  for (const plugin of adapter.plugins) {
    const errors: string[] = [];
    for (const req of plugin.manifest.hookRequires ?? []) {
      const violation = hookRequireViolation(req, localIds);
      if (violation) errors.push(`hookRequires (${req.event}): ${violation}`);
    }
    if (errors.length > 0) {
      throwInvariantViolations(join(plugin.pluginDir, SOURCE_PLUGIN_MANIFEST_TS), errors);
    }
  }
}

function hookRequireViolation(req: HookRequirement, localIds: LocalIds): string | null {
  if (req.skill !== undefined) {
    return localIds.skills.has(req.skill) ? null : `${req.skill} is not a local skill`;
  }
  if (req.command !== undefined) {
    return localIds.commands.has(req.command) ? null : `${req.command} is not a local command`;
  }
  if (req.agent !== undefined) {
    return localIds.agents.has(req.agent) ? null : `${req.agent} is not a local agent`;
  }
  return null;
}
