import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { compileTree, type WarningSink } from "./emit.js";
import { checkHookRootReads, checkHookSkillMirror } from "./hooks.js";
import { throwInvariantViolations } from "./discovery.js";
import { pathExists } from "../fs.js";
import { PluginManifestSchema } from "../install/discovery.js";
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
  readonly repoRoot?: string;
  readonly namedRoots?: Readonly<Record<string, string>>;
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
  await checkHookSkillMirror(adapter);

  const skipRelPaths: ReadonlySet<string> = new Set(vendors.map((v) => v.pluginManifestPath));
  for (const vendor of vendors) {
    await vendor.emitMarketplaceManifest({ outRoot, marketplace: adapter.marketplace });
  }
  const repoRoot = options.repoRoot ?? dirname(srcRoot);
  const namedRoots = options.namedRoots ?? {};
  for (const plugin of adapter.plugins) {
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
  await vendor.emitPluginManifest({ manifest: plugin.manifest, pluginOutDir });
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
