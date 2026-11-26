import { join } from "node:path";

import { extensionBlock, withoutExtensions } from "../../plugin/index.js";
import { pluginSourcePath, writeJson } from "../shared.js";
import type { Catalog } from "../../layout/index.js";
import type { VendorEmitContext } from "../../vendor/schema.js";

export const EXTENSION_KEY = "claude";
export const PLUGIN_MANIFEST_REL = ".claude-plugin/plugin.json";
export const CATALOG_REL = ".claude-plugin/marketplace.json";

export async function emitPluginManifest(ctx: VendorEmitContext): Promise<void> {
  const { manifest } = ctx.plugin;
  await writeJson(join(ctx.pluginOutDir, PLUGIN_MANIFEST_REL), {
    ...withoutExtensions(manifest),
    ...extensionBlock(manifest, EXTENSION_KEY),
  });
}

export async function emitCatalog(vendorDir: string, catalog: Catalog): Promise<void> {
  await writeJson(join(vendorDir, CATALOG_REL), {
    name: catalog.name,
    owner: catalog.owner,
    ...(catalog.extensions[EXTENSION_KEY] ?? {}),
    plugins: catalog.plugins.map((plugin) => ({
      name: plugin.name,
      source: pluginSourcePath(plugin.name),
      description: plugin.manifest.description,
    })),
  });
}
