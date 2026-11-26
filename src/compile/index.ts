import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { compileTree, type WarningSink } from "./emit.js";
import { checkHookRootReads, checkHookSkillMirror } from "./hooks.js";
import { throwInvariantViolations } from "./discovery.js";
import { vendorWorkspace, workspaceView } from "./trees.js";
import { overlayVendorNames } from "../vendor/builtins.js";
import { pathExists } from "../fs.js";
import { PluginManifestSchema } from "../install/discovery.js";
import {
  PLUGIN_MANIFEST,
  loadCatalogOrThrow,
  pluginBuildDir,
  vendorBuild,
  type VendorBuild,
  type Catalog,
  type Layout,
  type LocalIds,
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

export interface CompilePluginsOptions {
  readonly layout: Layout;
  readonly vendors: readonly Vendor[];
  readonly onWarnings?: WarningSink;
  readonly sources?: readonly PluginSource[];
  readonly catalog?: Catalog;
  readonly installedIndex?: InstalledIndex;
  readonly namedRoots?: Readonly<Record<string, string>>;
}

export async function compilePlugins(options: CompilePluginsOptions): Promise<void> {
  const { layout, vendors } = options;
  const outRoot = layout.buildDir;
  if (vendors.length === 0) {
    throw new Error("compilePlugins requires at least one vendor");
  }
  const catalog = options.catalog ?? (await loadCatalogOrThrow(layout));
  const installedIndex =
    options.installedIndex ??
    (await loadInstalledIndex(options.sources ?? defaultSources(vendors)));
  const namedRoots = options.namedRoots ?? {};
  const registeredVendors = overlayVendorNames(vendors);
  const workspaces = await Promise.all(
    vendors.map(async (vendor) => ({
      vendor,
      workspace: await vendorWorkspace(
        { plugins: catalog.plugins, namedRoots },
        { vendor: vendor.name, registeredVendors },
      ),
    })),
  );
  for (const { workspace } of workspaces) checkHookRequires(catalog, workspace.localIds);
  await checkHookRootReads(catalog);
  await checkHookSkillMirror(catalog);

  const skipRelPaths: ReadonlySet<string> = new Set([PLUGIN_MANIFEST]);
  for (const { vendor, workspace } of workspaces) {
    const build = vendorBuild(outRoot, vendor.name);
    await vendor.emitCatalog({ vendorDir: build.root, catalog });
    const render = {
      localIds: workspace.localIds,
      installedIndex,
      repoRoot: layout.repoRoot,
      namedRoots,
      ...(options.onWarnings ? { onWarnings: options.onWarnings } : {}),
    };
    for (const plugin of catalog.plugins) {
      const tree = workspace.pluginTrees.get(plugin.name);
      if (tree === undefined) continue;
      const pluginOutDir = pluginBuildDir(build, plugin.name);
      await vendor.emitPluginManifest({ plugin, pluginOutDir });
      await compileTree({
        tree,
        outRoot: pluginOutDir,
        skipRelPaths,
        render: { ...render, view: workspaceView(workspace, tree) },
      });
    }
  }
  for (const vendor of vendors) {
    await verifyEmittedPluginManifests({
      build: vendorBuild(outRoot, vendor.name),
      vendor,
      catalog,
    });
  }
}

interface EmittedVendorBuild {
  readonly build: VendorBuild;
  readonly vendor: Vendor;
  readonly catalog: Catalog;
}

async function verifyEmittedPluginManifests(emitted: EmittedVendorBuild): Promise<void> {
  const { build, vendor, catalog } = emitted;
  const parses = await Promise.all(
    catalog.plugins.map(async (plugin) =>
      pluginManifestParses(join(pluginBuildDir(build, plugin.name), vendor.pluginManifestPath)),
    ),
  );
  const unresolved = catalog.plugins.filter((_, i) => !parses[i]).map((plugin) => plugin.name);
  if (unresolved.length > 0) {
    throwInvariantViolations(join(build.root, vendor.catalogPath), [
      `catalog plugins with no emitted plugin manifest: ${unresolved.join("; ")}`,
    ]);
  }
}

async function pluginManifestParses(manifestPath: string): Promise<boolean> {
  if (!(await pathExists(manifestPath))) return false;
  try {
    return PluginManifestSchema.safeParse(JSON.parse(await readFile(manifestPath, "utf8"))).success;
  } catch {
    return false;
  }
}

async function loadInstalledIndex(sources: readonly PluginSource[]): Promise<InstalledIndex> {
  const artifacts = await discoverInstalled(sources);
  return indexInstalled(artifacts);
}

function checkHookRequires(catalog: Catalog, localIds: LocalIds): void {
  for (const plugin of catalog.plugins) {
    const errors: string[] = [];
    for (const req of plugin.hookRequires) {
      const violation = hookRequireViolation(req, localIds);
      if (violation) errors.push(`hookRequires (${req.event}): ${violation}`);
    }
    if (errors.length > 0) {
      throwInvariantViolations(plugin.manifestPath, errors);
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
