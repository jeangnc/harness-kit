import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { Marketplace, PluginEntry, PluginSource } from "../marketplace/index.js";
import type { Plugin } from "../plugin/index.js";
import type { VendorEmitContext, VendorMarketplaceEmitContext } from "../vendor/schema.js";

type VendorPluginManifest = Omit<Plugin, "hookRequires">;

function toVendorPluginManifest(plugin: Plugin): VendorPluginManifest {
  const { hookRequires: _hr, ...rest } = plugin;
  return rest;
}

export async function defaultEmitPluginManifest(
  manifestRelPath: string,
  ctx: VendorEmitContext,
): Promise<void> {
  await writeJson(join(ctx.pluginOutDir, manifestRelPath), toVendorPluginManifest(ctx.manifest));
}

export async function defaultEmitMarketplaceManifest(
  manifestRelPath: string,
  ctx: VendorMarketplaceEmitContext,
): Promise<void> {
  await writeJson(join(ctx.outRoot, manifestRelPath), projectMarketplaceForVendor(ctx.marketplace));
}

async function writeJson(target: string, value: unknown): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, JSON.stringify(value, null, 2) + "\n");
}

type ProjectedMetadata = Omit<NonNullable<Marketplace["metadata"]>, "pluginRoot">;
type ProjectedSource = string | Omit<PluginSource, "kind">;
type ProjectedPluginEntry = Omit<PluginEntry, "source"> & { source: ProjectedSource };
type ProjectedMarketplace = Omit<Marketplace, "metadata" | "plugins"> & {
  metadata?: ProjectedMetadata;
  plugins: ProjectedPluginEntry[];
};

function projectMarketplaceForVendor(marketplace: Marketplace): ProjectedMarketplace {
  const { metadata, plugins, ...rest } = marketplace;
  const metadataOut = stripPluginRoot(metadata);
  return {
    ...rest,
    ...(metadataOut ? { metadata: metadataOut } : {}),
    plugins: plugins.map(projectPluginEntry),
  };
}

function stripPluginRoot(metadata: Marketplace["metadata"]): ProjectedMetadata | undefined {
  if (!metadata) return undefined;
  const { pluginRoot: _pr, ...rest } = metadata;
  return Object.keys(rest).length > 0 ? rest : undefined;
}

function projectPluginEntry(entry: PluginEntry): ProjectedPluginEntry {
  const { source, ...rest } = entry;
  return { ...rest, source: projectSource(entry.name, source) };
}

function projectSource(pluginName: string, source: PluginSource): ProjectedSource {
  if (source.kind === "relative") return `./plugins/${pluginName}`;
  const { kind: _kind, ...rest } = source;
  return rest;
}
