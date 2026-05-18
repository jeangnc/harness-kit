import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { Plugin } from "../plugin/index.js";

type VendorPluginManifest = Omit<Plugin, "context" | "hookRequires">;

function toVendorPluginManifest(plugin: Plugin): VendorPluginManifest {
  const { context: _ctx, hookRequires: _hr, ...rest } = plugin;
  return rest;
}

export async function writeVendorPluginManifest(
  pluginOutDir: string,
  manifestRelPath: string,
  manifest: Plugin,
): Promise<void> {
  const target = join(pluginOutDir, manifestRelPath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, JSON.stringify(toVendorPluginManifest(manifest), null, 2) + "\n");
}
