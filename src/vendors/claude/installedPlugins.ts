import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import { z } from "zod";

import { errnoCode } from "../../fs.js";
import { formatZodIssues } from "../../errors/index.js";

const InstalledEntrySchema = z
  .object({
    scope: z.string().min(1),
    projectPath: z.string().min(1).optional(),
    installPath: z.string().min(1),
    version: z.string().min(1),
    installedAt: z.string().optional(),
    lastUpdated: z.string().optional(),
    gitCommitSha: z.string().optional(),
  })
  .passthrough();

const InstalledPluginsSchema = z
  .object({
    version: z.literal(2),
    plugins: z.record(z.string(), z.array(InstalledEntrySchema)),
  })
  .passthrough();

export type InstalledPlugins = z.infer<typeof InstalledPluginsSchema>;
export type InstalledEntry = z.infer<typeof InstalledEntrySchema>;

export interface EntryPatch {
  readonly installPath: string;
  readonly version: string;
  readonly lastUpdated: string;
}

function registryPath(home: string): string {
  return join(home, "plugins/installed_plugins.json");
}

export async function readInstalledPlugins(home: string): Promise<InstalledPlugins> {
  const path = registryPath(home);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (cause) {
    if (errnoCode(cause) === "ENOENT") return { version: 2, plugins: {} };
    throw new Error(`cannot read claude installed_plugins.json at ${path}`, { cause });
  }
  const parsed = InstalledPluginsSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new Error(
      `invalid claude installed_plugins.json at ${path}: ${formatZodIssues(parsed.error).join("; ")}`,
    );
  }
  return parsed.data;
}

export function patchInstalledEntries(
  registry: InstalledPlugins,
  key: string,
  patch: EntryPatch,
): InstalledPlugins {
  const entries = registry.plugins[key];
  if (entries === undefined) return registry;
  const patched = entries.map((entry) => ({ ...entry, ...patch }));
  return { ...registry, plugins: { ...registry.plugins, [key]: patched } };
}

export function removeInstalledEntries(
  registry: InstalledPlugins,
  keys: readonly string[],
): InstalledPlugins {
  const dropped = new Set(keys);
  const plugins = Object.fromEntries(
    Object.entries(registry.plugins).filter(([key]) => !dropped.has(key)),
  );
  return { ...registry, plugins };
}

export async function writeInstalledPlugins(
  home: string,
  registry: InstalledPlugins,
): Promise<void> {
  const path = registryPath(home);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
}
