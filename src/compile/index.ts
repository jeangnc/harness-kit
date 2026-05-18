import { join } from "node:path";

import { compileTree, type BodyInvariant, type OwningPlugin } from "./emit.js";
import { pathExists } from "../fs.js";
import { throwInvariantViolations } from "./discovery.js";
import { SOURCE_PLUGIN_MANIFEST_JSON, SOURCE_PLUGIN_MANIFEST_TS } from "../layout/conventions.js";
import {
  collectLocalIds,
  listMarkdownNames,
  loadLayout,
  type LayoutAdapter,
  type LocalIds,
  type ResolvedPlugin,
} from "../layout/index.js";
import type { DependencyEntry, HookRequirement } from "../plugin/index.js";
import type { Vendor } from "../vendor/schema.js";

export type { BodyInvariant } from "./emit.js";

export interface CompileOptions {
  readonly srcRoot: string;
  readonly outRoot: string;
  readonly vendors: readonly Vendor[];
  readonly bodyInvariants?: readonly BodyInvariant[];
}

export async function compile(options: CompileOptions): Promise<void> {
  const { srcRoot, outRoot, vendors } = options;
  if (vendors.length === 0) {
    throw new Error("compile requires at least one vendor");
  }
  const adapter = await loadAdapter(srcRoot);
  const localIds = await collectLocalIds(adapter);
  await checkContextFiles(adapter);
  checkHookRequires(adapter, localIds);

  const skipRelPaths: ReadonlySet<string> = new Set(vendors.map((v) => v.pluginManifestPath));
  for (const vendor of vendors) {
    await vendor.emitMarketplaceManifest({ outRoot, marketplace: adapter.marketplace });
  }
  for (const plugin of adapter.plugins) {
    for (const vendor of vendors) {
      await emitPluginForVendor(
        plugin,
        vendor,
        outRoot,
        localIds,
        skipRelPaths,
        options.bodyInvariants ?? [],
      );
    }
  }
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

async function emitPluginForVendor(
  plugin: ResolvedPlugin,
  vendor: Vendor,
  outRoot: string,
  localIds: LocalIds,
  skipRelPaths: ReadonlySet<string>,
  bodyInvariants: readonly BodyInvariant[],
): Promise<void> {
  const pluginOutDir = vendor.pluginOutDir(outRoot, plugin.name);
  await vendor.emitPluginManifest({ manifest: plugin.manifest, pluginOutDir });
  const contextFiles = await collectSubstitutableFiles(plugin);
  const owner: OwningPlugin = {
    name: plugin.name,
    dependencies: new Set((plugin.manifest.dependencies ?? []).map(dependencyName)),
  };
  await compileTree({
    srcRoot: plugin.pluginDir,
    outRoot: pluginOutDir,
    localIds,
    bodyInvariants,
    contextFiles,
    owner,
    skipRelPaths,
  });
}

async function collectSubstitutableFiles(plugin: ResolvedPlugin): Promise<ReadonlySet<string>> {
  const result = new Set<string>();
  for (const entry of plugin.manifest.context ?? []) {
    result.add(join(plugin.pluginDir, entry.file));
  }
  for (const dir of [plugin.agentsDir, plugin.commandsDir]) {
    for (const name of await listMarkdownNames(dir)) {
      result.add(join(dir, `${name}.md`));
    }
  }
  return result;
}

async function checkContextFiles(adapter: LayoutAdapter): Promise<void> {
  for (const plugin of adapter.plugins) {
    const errors: string[] = [];
    for (const entry of plugin.manifest.context ?? []) {
      if (!(await pathExists(join(plugin.pluginDir, entry.file)))) {
        errors.push(`context entry: file not found: ${entry.file}`);
      }
    }
    if (errors.length > 0) {
      throwInvariantViolations(join(plugin.pluginDir, SOURCE_PLUGIN_MANIFEST_TS), errors);
    }
  }
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

function dependencyName(entry: DependencyEntry): string {
  return typeof entry === "string" ? entry : entry.name;
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
