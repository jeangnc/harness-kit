import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parse, type TomlTable, type TomlValue } from "smol-toml";
import { z } from "zod";

import { defaultRunner, type CommandRunner } from "../install/runner.js";
import { CATALOG_REL, PLUGIN_MANIFEST_REL } from "../vendors/codex/emit.js";
import { assertRegular, command, readJson } from "./io.js";
import { contains, type ProjectLocation } from "./location.js";
import { readMetadata } from "./state.js";

export interface ProjectMarketplace {
  readonly name: string;
  readonly path: string;
}

export interface ProjectPreset {
  readonly name: string;
  readonly marketplaces: readonly ProjectMarketplace[];
  readonly config: TomlTable;
  readonly instructions?: string;
}

interface ConfigScope {
  readonly cwd: string;
  readonly config: TomlTable;
}

interface ConfigFile extends ConfigScope {
  readonly path: string;
}

interface CatalogPlugin {
  readonly path: string;
  readonly version: string;
}

export interface ProjectPlan extends ProjectLocation {
  readonly preset: string;
  readonly marketplaces: readonly ProjectMarketplace[];
  readonly config: TomlTable;
  readonly configFiles: readonly ConfigFile[];
  readonly scopes: readonly ConfigScope[];
  readonly plugins: readonly string[];
  readonly catalog: ReadonlyMap<string, CatalogPlugin>;
  readonly instructions?: string;
}

const ManifestSchema = z.object({
  name: z.string(),
  plugins: z.array(
    z.object({
      name: z.string(),
      source: z.object({ source: z.literal("local"), path: z.string() }),
    }),
  ),
});
const PluginSchema = z.object({ name: z.string(), version: z.string().min(1) });

export async function prepareProject(
  options: { readonly location: ProjectLocation; readonly preset?: ProjectPreset },
  run: CommandRunner = defaultRunner,
): Promise<ProjectPlan> {
  const { location, preset } = options;
  const metadata = readMetadata(location);
  if (metadata && preset && metadata.preset !== preset.name) {
    throw new Error(`Existing home uses ${metadata.preset}; refusing to replace its harness`);
  }
  if (existsSync(location.home) && !metadata) {
    throw new Error(`Refusing to adopt an unrecognized home at ${location.home}`);
  }
  const name = metadata?.preset ?? preset?.name;
  if (!name) throw new Error("Project setup requires an explicit preset");
  const marketplaces = (metadata?.marketplaces ?? preset?.marketplaces ?? []).map(
    (marketplace) => ({ ...marketplace, path: realpathSync(marketplace.path) }),
  );
  const catalog = readCatalog(marketplaces);
  const configPath = join(location.home, "config.toml");
  assertRegular(configPath, "file");
  const config = existsSync(configPath)
    ? readToml(configPath)
    : merge(
        {
          plugins: Object.fromEntries([...catalog.keys()].map((key) => [key, { enabled: false }])),
        },
        preset?.config ?? {},
      );
  if (!existsSync(configPath)) {
    config["marketplaces"] = Object.fromEntries(
      marketplaces.map(({ name: marketplace, path }) => [
        marketplace,
        { source_type: "local", source: path },
      ]),
    );
  }
  const configFiles = await projectConfigs(location.project, run);
  const scopes = [...new Set([location.project, ...configFiles.map(({ cwd }) => cwd)])].map(
    (cwd) => ({
      cwd,
      config: configFiles
        .filter((entry) => contains(entry.cwd, cwd))
        .reduce((current, entry) => merge(current, entry.config), merge({}, config)),
    }),
  );
  const plugins = [...new Set(scopes.flatMap((scope) => enabledPlugins(scope.config)))].sort();
  for (const plugin of plugins) {
    if (!catalog.has(plugin)) {
      throw new Error(`Enabled plugin ${plugin} is not in the selected local marketplaces`);
    }
  }
  return {
    ...location,
    preset: name,
    marketplaces,
    config,
    configFiles,
    scopes,
    plugins,
    catalog,
    ...(preset?.instructions !== undefined ? { instructions: preset.instructions } : {}),
  };
}

function readCatalog(
  marketplaces: readonly ProjectMarketplace[],
): ReadonlyMap<string, CatalogPlugin> {
  const catalog = new Map<string, CatalogPlugin>();
  const names = new Set<string>();
  for (const marketplace of marketplaces) {
    if (names.has(marketplace.name)) throw new Error(`Duplicate marketplace ${marketplace.name}`);
    names.add(marketplace.name);
    const manifestPath = join(marketplace.path, CATALOG_REL);
    if (!existsSync(manifestPath)) {
      throw new Error(`Build ${marketplace.name} with harness build; missing ${manifestPath}`);
    }
    const manifest = ManifestSchema.safeParse(readJson(manifestPath));
    if (!manifest.success || manifest.data.name !== marketplace.name) {
      throw new Error(`Marketplace identity differs at ${manifestPath}`);
    }
    for (const plugin of manifest.data.plugins) {
      const path = resolve(marketplace.path, plugin.source.path);
      const details = PluginSchema.safeParse(readJson(join(path, PLUGIN_MANIFEST_REL)));
      const key = `${plugin.name}@${marketplace.name}`;
      if (!details.success || details.data.name !== plugin.name || catalog.has(key)) {
        throw new Error(`Plugin identity differs at ${path}`);
      }
      catalog.set(key, { version: details.data.version, path });
    }
  }
  return catalog;
}

function readToml(path: string): TomlTable {
  try {
    return parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`Unable to parse TOML at ${path}; contents withheld`);
  }
}

function merge(base: TomlTable, override: TomlTable): TomlTable {
  const merged = { ...base };
  for (const [key, value] of Object.entries(override)) {
    merged[key] = isTable(value) ? merge(table(base[key]), value) : value;
  }
  return merged;
}

function isTable(value: TomlValue | undefined): value is TomlTable {
  return (
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

export function table(value: TomlValue | undefined): TomlTable {
  return isTable(value) ? value : {};
}

async function projectConfigs(project: string, run: CommandRunner): Promise<readonly ConfigFile[]> {
  const configs: ConfigFile[] = [];
  for (const path of codexConfigPaths(project)) {
    const cwd = dirname(dirname(path));
    if (hasNestedGitBoundary(project, cwd)) continue;
    const root = realpathSync(
      (await command({ run, program: "git", args: ["rev-parse", "--show-toplevel"], cwd })).trim(),
    );
    if (root === project) configs.push({ cwd, path, config: readToml(path) });
  }
  return configs.sort((a, b) => a.cwd.length - b.cwd.length);
}

function codexConfigPaths(directory: string): readonly string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (!entry.isDirectory() || entry.name === ".git") return [];
    const path = join(directory, entry.name);
    const config = join(path, "config.toml");
    const own =
      entry.name === ".codex" && lstatSync(config, { throwIfNoEntry: false })?.isFile()
        ? [config]
        : [];
    return [...own, ...codexConfigPaths(path)];
  });
}

function hasNestedGitBoundary(project: string, cwd: string): boolean {
  for (let path = cwd; path !== project && contains(project, path); path = dirname(path)) {
    if (lstatSync(join(path, ".git"), { throwIfNoEntry: false })) return true;
  }
  return false;
}

export function enabledPlugins(config: TomlTable): string[] {
  return Object.entries(table(config["plugins"]))
    .filter(([, value]) => table(value)["enabled"] === true)
    .map(([key]) => key)
    .sort();
}
