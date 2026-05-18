import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { formatZodIssues } from "../errors/index.js";
import { pathExists } from "../fs.js";
import type { DiscoveredVendorPlugin, Vendor } from "../vendor/schema.js";

export const PluginManifestSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
});

export type PluginManifest = z.infer<typeof PluginManifestSchema>;

const MarketplaceManifestSchema = z.object({
  name: z.string().min(1),
});

export async function readMarketplaceName(distRoot: string, vendor: Vendor): Promise<string> {
  const manifestPath = join(distRoot, vendor.marketplaceManifestPath);
  const raw = await readFile(manifestPath, "utf8");
  const parsed = MarketplaceManifestSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new Error(
      `invalid marketplace manifest at ${manifestPath}: ${formatZodIssues(parsed.error).join("; ")}`,
    );
  }
  return parsed.data.name;
}

export async function discoverPluginsForVendor(
  distRoot: string,
  vendor: Vendor,
): Promise<readonly DiscoveredVendorPlugin[]> {
  const vendorDir = vendor.vendorOutDir(distRoot);
  if (!(await pathExists(vendorDir))) return [];
  const entries = await readdir(vendorDir, { withFileTypes: true });
  const result: DiscoveredVendorPlugin[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const path = vendor.pluginOutDir(distRoot, entry.name);
    const manifest = await tryReadManifest(join(path, vendor.pluginManifestPath));
    if (!manifest) continue;
    result.push({ name: entry.name, path, version: manifest.version });
  }
  return result;
}

async function tryReadManifest(path: string): Promise<PluginManifest | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return null;
  }
  const parsed = PluginManifestSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new Error(
      `invalid plugin manifest at ${path}: ${formatZodIssues(parsed.error).join("; ")}`,
    );
  }
  return parsed.data;
}
