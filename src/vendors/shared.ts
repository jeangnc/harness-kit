import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { Plugin } from "../plugin/index.js";
import type { PluginPartition, VendorInstallContext } from "../vendor/schema.js";

export function defaultPartition(ctx: VendorInstallContext): PluginPartition {
  return { enabled: ctx.plugins, disabled: [] };
}

export async function writeJson(target: string, value: unknown): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, JSON.stringify(value, null, 2) + "\n");
}

export function pluginSourcePath(pluginName: string): string {
  return `./plugins/${pluginName}`;
}

export function pluginIdentity(manifest: Plugin): Pick<Plugin, "name" | "version"> {
  return { name: manifest.name, version: manifest.version };
}
