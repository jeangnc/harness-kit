import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  SOURCE_MARKETPLACE_MANIFEST,
  SOURCE_PLUGIN_MANIFEST_JSON,
  SOURCE_PLUGIN_MANIFEST_TS,
} from "./conventions.js";
import { formatZodIssues } from "../errors/index.js";
import { pathExists } from "../fs.js";
import { MarketplaceSchema, type Marketplace, type PluginEntry } from "../marketplace/index.js";
import { PluginSchema, type Plugin } from "../plugin/index.js";
import { err, ok, type Result } from "../result.js";

export interface ResolvedPlugin {
  readonly name: string;
  readonly pluginDir: string;
  readonly manifest: Plugin;
  readonly manifestSource: "PLUGIN.ts" | "plugin.json";
  readonly skillsDir: string;
  readonly commandsDir: string;
  readonly agentsDir: string;
  readonly hooksDir: string;
}

export interface OpaquePlugin {
  readonly name: string;
  readonly source: Exclude<PluginEntry["source"], { kind: "relative" }>;
}

export interface LayoutAdapter {
  readonly srcRoot: string;
  readonly marketplace: Marketplace;
  readonly plugins: readonly ResolvedPlugin[];
  readonly opaquePlugins: readonly OpaquePlugin[];
}

export type LayoutError =
  | { readonly kind: "marketplace-missing"; readonly path: string }
  | {
      readonly kind: "marketplace-invalid";
      readonly path: string;
      readonly issues: readonly string[];
    }
  | { readonly kind: "plugin-missing"; readonly name: string; readonly path: string }
  | { readonly kind: "manifest-missing"; readonly name: string; readonly pluginDir: string }
  | { readonly kind: "manifest-collision"; readonly name: string; readonly pluginDir: string }
  | {
      readonly kind: "manifest-invalid";
      readonly name: string;
      readonly path: string;
      readonly issues: readonly string[];
    }
  | {
      readonly kind: "plugin-name-mismatch";
      readonly entryName: string;
      readonly manifestName: string;
      readonly path: string;
    };

export function formatLayoutError(error: LayoutError): string {
  switch (error.kind) {
    case "marketplace-missing":
      return `marketplace manifest not found at ${error.path}`;
    case "marketplace-invalid":
      return `marketplace manifest at ${error.path} is invalid: ${error.issues.join("; ")}`;
    case "plugin-missing":
      return `plugin "${error.name}" not found at ${error.path}`;
    case "manifest-missing":
      return `plugin "${error.name}" has no manifest at ${error.pluginDir}`;
    case "manifest-collision":
      return `plugin "${error.name}" has both PLUGIN.ts and plugin.json at ${error.pluginDir} — pick one`;
    case "manifest-invalid":
      return `plugin manifest at ${error.path} is invalid: ${error.issues.join("; ")}`;
    case "plugin-name-mismatch":
      return `plugin entry "${error.entryName}" does not match manifest name "${error.manifestName}" at ${error.path}`;
  }
}

function resolvePluginDir(srcRoot: string, pluginRoot: string | undefined, source: string): string {
  if (source.startsWith("./") || source.startsWith("../") || source === ".") {
    return resolve(srcRoot, source);
  }
  if (pluginRoot !== undefined) {
    return resolve(srcRoot, pluginRoot, source);
  }
  return resolve(srcRoot, source);
}

async function loadPluginManifest(
  entryName: string,
  pluginDir: string,
): Promise<Result<{ manifest: Plugin; source: "PLUGIN.ts" | "plugin.json" }, LayoutError>> {
  const tsPath = join(pluginDir, SOURCE_PLUGIN_MANIFEST_TS);
  const jsonPath = join(pluginDir, SOURCE_PLUGIN_MANIFEST_JSON);
  const [hasTs, hasJson] = await Promise.all([pathExists(tsPath), pathExists(jsonPath)]);

  if (hasTs && hasJson) {
    return err({ kind: "manifest-collision", name: entryName, pluginDir });
  }
  if (!hasTs && !hasJson) {
    return err({ kind: "manifest-missing", name: entryName, pluginDir });
  }

  if (hasTs) {
    const mod = (await import(pathToFileURL(tsPath).href)) as { default: unknown };
    const parsed = PluginSchema.safeParse(mod.default);
    if (!parsed.success) {
      return err({
        kind: "manifest-invalid",
        name: entryName,
        path: tsPath,
        issues: formatZodIssues(parsed.error),
      });
    }
    return ok({ manifest: parsed.data, source: "PLUGIN.ts" });
  }

  const raw = await readFile(jsonPath, "utf8");
  const parsed = PluginSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    return err({
      kind: "manifest-invalid",
      name: entryName,
      path: jsonPath,
      issues: formatZodIssues(parsed.error),
    });
  }
  return ok({ manifest: parsed.data, source: "plugin.json" });
}

export async function loadLayout(srcRoot: string): Promise<Result<LayoutAdapter, LayoutError>> {
  const marketplacePath = join(srcRoot, SOURCE_MARKETPLACE_MANIFEST);
  if (!(await pathExists(marketplacePath))) {
    return err({ kind: "marketplace-missing", path: marketplacePath });
  }

  const rawMarketplace = await readFile(marketplacePath, "utf8");
  const parsed = MarketplaceSchema.safeParse(JSON.parse(rawMarketplace));
  if (!parsed.success) {
    return err({
      kind: "marketplace-invalid",
      path: marketplacePath,
      issues: formatZodIssues(parsed.error),
    });
  }
  const marketplace = parsed.data;
  const pluginRoot = marketplace.metadata?.pluginRoot;

  const plugins: ResolvedPlugin[] = [];
  const opaquePlugins: OpaquePlugin[] = [];

  for (const entry of marketplace.plugins) {
    if (entry.source.kind !== "relative") {
      opaquePlugins.push({ name: entry.name, source: entry.source });
      continue;
    }

    const pluginDir = resolvePluginDir(srcRoot, pluginRoot, entry.source.path);
    if (!(await pathExists(pluginDir))) {
      return err({ kind: "plugin-missing", name: entry.name, path: pluginDir });
    }

    const manifestResult = await loadPluginManifest(entry.name, pluginDir);
    if (!manifestResult.ok) return manifestResult;
    const { manifest, source: manifestSource } = manifestResult.value;

    if (manifest.name !== entry.name) {
      return err({
        kind: "plugin-name-mismatch",
        entryName: entry.name,
        manifestName: manifest.name,
        path: join(
          pluginDir,
          manifestSource === "PLUGIN.ts" ? SOURCE_PLUGIN_MANIFEST_TS : SOURCE_PLUGIN_MANIFEST_JSON,
        ),
      });
    }

    plugins.push({
      name: entry.name,
      pluginDir,
      manifest,
      manifestSource,
      skillsDir: join(pluginDir, "skills"),
      commandsDir: join(pluginDir, manifest.commands ?? "commands"),
      agentsDir: join(pluginDir, manifest.agents ?? "agents"),
      hooksDir: join(pluginDir, manifest.hooks ?? "hooks"),
    });
  }

  return ok({ srcRoot, marketplace, plugins, opaquePlugins });
}

export interface LocalIds {
  readonly skills: ReadonlySet<string>;
  readonly commands: ReadonlySet<string>;
  readonly agents: ReadonlySet<string>;
}

export async function collectLocalIds(adapter: LayoutAdapter): Promise<LocalIds> {
  const skills = new Set<string>();
  const commands = new Set<string>();
  const agents = new Set<string>();
  for (const plugin of adapter.plugins) {
    for (const name of await listSkillNames(plugin.skillsDir)) {
      skills.add(`${plugin.name}:${name}`);
    }
    for (const name of await listMarkdownNames(plugin.commandsDir)) {
      commands.add(`${plugin.name}:${name}`);
    }
    for (const name of await listMarkdownNames(plugin.agentsDir)) {
      agents.add(`${plugin.name}:${name}`);
    }
  }
  return { skills, commands, agents };
}

async function listSkillNames(dir: string): Promise<readonly string[]> {
  if (!(await pathExists(dir))) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillDir = join(dir, entry.name);
    const [hasTs, hasMd] = await Promise.all([
      pathExists(join(skillDir, "SKILL.ts")),
      pathExists(join(skillDir, "SKILL.md")),
    ]);
    if (hasTs || hasMd) out.push(entry.name);
  }
  return out;
}

export async function listMarkdownNames(dir: string): Promise<readonly string[]> {
  if (!(await pathExists(dir))) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".md")) continue;
    out.push(entry.name.slice(0, -3));
  }
  return out;
}
