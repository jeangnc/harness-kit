import { access, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { builtinVendors } from "./vendor/builtins.js";
import type { Vendor } from "./vendor/schema.js";

const PluginManifestSchema = z.object({ name: z.string().min(1) });

export interface PluginSource {
  readonly name: string;
  readonly root: string;
  readonly manifestRelativePath: string;
}

export interface InstalledSkill {
  readonly source: string;
  readonly marketplace: string;
  readonly plugin: string;
  readonly skill: string;
  readonly path: string;
}

export interface InstalledCommand {
  readonly source: string;
  readonly marketplace: string;
  readonly plugin: string;
  readonly command: string;
  readonly path: string;
}

export interface InstalledAgent {
  readonly source: string;
  readonly marketplace: string;
  readonly plugin: string;
  readonly agent: string;
  readonly path: string;
}

export interface InstalledArtifacts {
  readonly skills: readonly InstalledSkill[];
  readonly commands: readonly InstalledCommand[];
  readonly agents: readonly InstalledAgent[];
}

export interface InstalledIndex {
  readonly skills: ReadonlyMap<string, readonly InstalledSkill[]>;
  readonly commands: ReadonlyMap<string, readonly InstalledCommand[]>;
  readonly agents: ReadonlyMap<string, readonly InstalledAgent[]>;
}

export function defaultSources(
  vendors: readonly Vendor[] = builtinVendors(),
): readonly PluginSource[] {
  return vendors.map((vendor) => ({
    name: vendor.name,
    root: join(vendor.home, "plugins/cache"),
    manifestRelativePath: vendor.pluginManifestPath,
  }));
}

export async function discoverInstalled(
  sources: readonly PluginSource[],
): Promise<InstalledArtifacts> {
  const skills: InstalledSkill[] = [];
  const commands: InstalledCommand[] = [];
  const agents: InstalledAgent[] = [];
  for (const source of sources) {
    for await (const pluginRoot of findPluginRoots(source.root, source.manifestRelativePath)) {
      for await (const skillFile of collectSkills(pluginRoot.root)) {
        skills.push({
          source: source.name,
          marketplace: pluginRoot.marketplace,
          plugin: pluginRoot.name,
          skill: skillFile.name,
          path: skillFile.path,
        });
      }
      for await (const commandFile of collectFlat(pluginRoot.root, "commands")) {
        commands.push({
          source: source.name,
          marketplace: pluginRoot.marketplace,
          plugin: pluginRoot.name,
          command: commandFile.name,
          path: commandFile.path,
        });
      }
      for await (const agentFile of collectFlat(pluginRoot.root, "agents")) {
        agents.push({
          source: source.name,
          marketplace: pluginRoot.marketplace,
          plugin: pluginRoot.name,
          agent: agentFile.name,
          path: agentFile.path,
        });
      }
    }
  }
  return { skills, commands, agents };
}

export function indexInstalled(artifacts: InstalledArtifacts): InstalledIndex {
  return {
    skills: groupBy(artifacts.skills, (s) => `${s.plugin}:${s.skill}`),
    commands: groupBy(artifacts.commands, (c) => `${c.plugin}:${c.command}`),
    agents: groupBy(artifacts.agents, (a) => `${a.plugin}:${a.agent}`),
  };
}

function groupBy<T>(items: readonly T[], key: (t: T) => string): ReadonlyMap<string, readonly T[]> {
  const result = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const existing = result.get(k);
    if (existing) existing.push(item);
    else result.set(k, [item]);
  }
  return result;
}

interface PluginRoot {
  readonly name: string;
  readonly root: string;
  readonly marketplace: string;
}

async function* findPluginRoots(
  dir: string,
  manifestRelativePath: string,
  marketplace?: string,
): AsyncGenerator<PluginRoot> {
  const name = await readPluginName(join(dir, manifestRelativePath));
  if (name !== null) {
    yield { name, root: dir, marketplace: marketplace ?? "" };
    return;
  }
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      yield* findPluginRoots(
        join(dir, entry.name),
        manifestRelativePath,
        marketplace ?? entry.name,
      );
    }
  }
}

interface NamedFile {
  readonly name: string;
  readonly path: string;
}

async function* collectSkills(pluginRoot: string): AsyncGenerator<NamedFile> {
  const skillsDir = join(pluginRoot, "skills");
  let entries;
  try {
    entries = await readdir(skillsDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const skillFile = join(skillsDir, entry.name, "SKILL.md");
    try {
      await access(skillFile);
    } catch {
      continue;
    }
    yield { name: entry.name, path: skillFile };
  }
}

async function* collectFlat(pluginRoot: string, subdir: string): AsyncGenerator<NamedFile> {
  const dir = join(pluginRoot, subdir);
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    if (entry.isFile() && entry.name.endsWith(".md")) {
      yield { name: entry.name.slice(0, -3), path: join(dir, entry.name) };
    }
  }
}

async function readPluginName(manifestPath: string): Promise<string | null> {
  let raw: string;
  try {
    raw = await readFile(manifestPath, "utf8");
  } catch {
    return null;
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = PluginManifestSchema.safeParse(json);
  return parsed.success ? parsed.data.name : null;
}
