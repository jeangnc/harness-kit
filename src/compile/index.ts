import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { compileTree, type WarningSink } from "./emit.js";
import { checkHookRootReads, checkHookSkillMirror } from "./hooks.js";
import { throwInvariantViolations } from "./discovery.js";
import { pathExists } from "../fs.js";
import { PluginManifestSchema } from "../install/discovery.js";
import {
  PLUGIN_MANIFEST,
  collectLocalIds,
  loadCatalogOrThrow,
  type Catalog,
  type Layout,
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

export interface CompilePluginsOptions {
  readonly layout: Layout;
  readonly vendors: readonly Vendor[];
  readonly onWarnings?: WarningSink;
  readonly sources?: readonly PluginSource[];
  readonly catalog?: Catalog;
  readonly localIds?: LocalIds;
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
  const localIds = options.localIds ?? (await collectLocalIds(catalog));
  const installedIndex =
    options.installedIndex ??
    (await loadInstalledIndex(options.sources ?? defaultSources(vendors)));
  checkHookRequires(catalog, localIds);
  await checkHookRootReads(catalog);
  await checkHookSkillMirror(catalog);

  const skipRelPaths: ReadonlySet<string> = new Set([PLUGIN_MANIFEST]);
  for (const vendor of vendors) {
    await vendor.emitMarketplaceManifest({ outRoot, catalog });
  }
  const repoRoot = layout.repoRoot;
  const namedRoots = options.namedRoots ?? {};
  for (const plugin of catalog.plugins) {
    for (const vendor of vendors) {
      await emitPluginForVendor(plugin, vendor, {
        outRoot,
        localIds,
        installedIndex,
        skipRelPaths,
        repoRoot,
        namedRoots,
        ...(options.onWarnings ? { onWarnings: options.onWarnings } : {}),
      });
    }
  }
  for (const vendor of vendors) {
    await verifyEmittedMarketplaceSources(outRoot, vendor);
  }
}

export async function verifyEmittedMarketplaceSources(
  outRoot: string,
  vendor: Vendor,
): Promise<void> {
  const manifestPath = join(outRoot, vendor.marketplaceManifestPath);
  const marketplace = JSON.parse(await readFile(manifestPath, "utf8")) as {
    plugins: ReadonlyArray<{ name: string; source: unknown }>;
  };
  const unresolved: string[] = [];
  for (const { name, source } of marketplace.plugins) {
    if (typeof source !== "string") continue;
    const target = join(vendor.pluginOutDir(outRoot, name), vendor.pluginManifestPath);
    if (!(await pluginManifestParses(target))) unresolved.push(`${name} → ${source}`);
  }
  if (unresolved.length > 0) {
    throwInvariantViolations(manifestPath, [
      `plugin sources with no emitted plugin manifest: ${unresolved.join("; ")}`,
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

interface EmitPluginOptions {
  readonly outRoot: string;
  readonly localIds: LocalIds;
  readonly installedIndex: InstalledIndex;
  readonly skipRelPaths: ReadonlySet<string>;
  readonly repoRoot: string;
  readonly namedRoots: Readonly<Record<string, string>>;
  readonly onWarnings?: WarningSink;
}

async function emitPluginForVendor(
  plugin: ResolvedPlugin,
  vendor: Vendor,
  options: EmitPluginOptions,
): Promise<void> {
  const pluginOutDir = vendor.pluginOutDir(options.outRoot, plugin.name);
  await vendor.emitPluginManifest({ plugin, pluginOutDir });
  await compileTree({
    srcRoot: plugin.pluginDir,
    outRoot: pluginOutDir,
    localIds: options.localIds,
    installedIndex: options.installedIndex,
    skipRelPaths: options.skipRelPaths,
    repoRoot: options.repoRoot,
    namedRoots: options.namedRoots,
    ...(options.onWarnings ? { onWarnings: options.onWarnings } : {}),
  });
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
