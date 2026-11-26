import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { loadHarnessConfig, type HarnessConfig, type Owner } from "../config/harness.js";
import { formatZodIssues } from "../errors/index.js";
import { pathExists } from "../fs.js";
import {
  HARNESS_EXTENSION,
  HarnessExtensionSchema,
  PluginSchema,
  extensionBlock,
  type HookRequirement,
  type Plugin,
} from "../plugin/index.js";
import { err, ok, type Result } from "../result.js";

export const PLUGIN_MANIFEST = "plugin.json";

export interface Layout {
  readonly repoRoot: string;
  readonly pluginsDir: string;
  readonly configsDir: string;
  readonly buildDir: string;
}

export function layoutAt(repoRoot: string): Layout {
  const root = resolve(repoRoot);
  return {
    repoRoot: root,
    pluginsDir: join(root, "plugins"),
    configsDir: join(root, "configs"),
    buildDir: join(root, ".harness"),
  };
}

export function legacyBuildDir(repoRoot: string): string {
  return join(resolve(repoRoot), "dist");
}

export interface ResolvedPlugin {
  readonly name: string;
  readonly pluginDir: string;
  readonly manifestPath: string;
  readonly manifest: Plugin;
  readonly hookRequires: readonly HookRequirement[];
  readonly hooksDir: string;
}

export interface Catalog {
  readonly name: string;
  readonly owner: Owner;
  readonly extensions: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly plugins: readonly ResolvedPlugin[];
}

export type LayoutError =
  | { readonly kind: "manifest-missing"; readonly pluginDir: string }
  | { readonly kind: "manifest-unreadable"; readonly path: string; readonly reason: string }
  | {
      readonly kind: "manifest-invalid";
      readonly path: string;
      readonly issues: readonly string[];
    }
  | {
      readonly kind: "plugin-name-mismatch";
      readonly folderName: string;
      readonly manifestName: string;
      readonly path: string;
    };

export function formatLayoutError(error: LayoutError): string {
  switch (error.kind) {
    case "manifest-missing":
      return `expected ${PLUGIN_MANIFEST} in plugin folder ${error.pluginDir}`;
    case "manifest-unreadable":
      return `could not parse plugin manifest at ${error.path}: ${error.reason}`;
    case "manifest-invalid":
      return `plugin manifest at ${error.path} is invalid: ${error.issues.join("; ")}`;
    case "plugin-name-mismatch":
      return `plugin manifest name "${error.manifestName}" does not match folder "${error.folderName}" at ${error.path}`;
  }
}

export async function loadCatalog(
  layout: Layout,
  config: HarnessConfig,
): Promise<Result<Catalog, LayoutError>> {
  const plugins: ResolvedPlugin[] = [];
  for (const folderName of await listPluginFolders(layout.pluginsDir)) {
    const resolved = await resolvePlugin(join(layout.pluginsDir, folderName), folderName);
    if (!resolved.ok) return resolved;
    plugins.push(resolved.value);
  }
  return ok({
    name: config.marketplace,
    owner: config.owner,
    extensions: Object.fromEntries(config.vendors.map((v) => [v.name, v.catalog])),
    plugins,
  });
}

async function listPluginFolders(pluginsDir: string): Promise<readonly string[]> {
  if (!(await pathExists(pluginsDir))) return [];
  const entries = await readdir(pluginsDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort();
}

async function resolvePlugin(
  pluginDir: string,
  folderName: string,
): Promise<Result<ResolvedPlugin, LayoutError>> {
  const manifestPath = join(pluginDir, PLUGIN_MANIFEST);
  if (!(await pathExists(manifestPath))) return err({ kind: "manifest-missing", pluginDir });
  const manifest = await parseManifest(manifestPath);
  if (!manifest.ok) return manifest;
  if (manifest.value.name !== folderName) {
    return err({
      kind: "plugin-name-mismatch",
      folderName,
      manifestName: manifest.value.name,
      path: manifestPath,
    });
  }
  const harness = HarnessExtensionSchema.safeParse(
    extensionBlock(manifest.value, HARNESS_EXTENSION),
  );
  if (!harness.success) {
    return err({
      kind: "manifest-invalid",
      path: manifestPath,
      issues: formatZodIssues(harness.error).map((issue) => `extensions.harness: ${issue}`),
    });
  }
  return ok({
    name: folderName,
    pluginDir,
    manifestPath,
    manifest: manifest.value,
    hookRequires: harness.data.hookRequires ?? [],
    hooksDir: join(pluginDir, "hooks"),
  });
}

async function parseManifest(path: string): Promise<Result<Plugin, LayoutError>> {
  let doc: unknown;
  try {
    doc = JSON.parse(await readFile(path, "utf8"));
  } catch (e) {
    return err({
      kind: "manifest-unreadable",
      path,
      reason: e instanceof Error ? e.message : String(e),
    });
  }
  const parsed = PluginSchema.safeParse(doc);
  if (!parsed.success) {
    return err({ kind: "manifest-invalid", path, issues: formatZodIssues(parsed.error) });
  }
  return ok(parsed.data);
}

export interface LocalIds {
  readonly skills: ReadonlySet<string>;
  readonly commands: ReadonlySet<string>;
  readonly agents: ReadonlySet<string>;
}

export interface VendorBuild {
  readonly root: string;
  readonly pluginsDir: string;
  readonly configsDir: string;
}

export function vendorBuild(buildDir: string, vendor: string): VendorBuild {
  const root = join(buildDir, vendor);
  return { root, pluginsDir: join(root, "plugins"), configsDir: join(root, "configs") };
}

export function pluginBuildDir(build: VendorBuild, pluginName: string): string {
  return join(build.pluginsDir, pluginName);
}

export async function loadCatalogOrThrow(layout: Layout): Promise<Catalog> {
  const result = await loadCatalog(layout, await loadHarnessConfig(layout.repoRoot));
  if (result.ok) return result.value;
  throw new Error(formatLayoutError(result.error));
}

export function catalogIdentity(catalog: Catalog): Pick<Catalog, "name" | "owner"> {
  return { name: catalog.name, owner: catalog.owner };
}
