import { join } from "node:path";

import { extensionBlock, withoutExtensions } from "../../plugin/index.js";
import { pluginIdentity, pluginSourcePath, writeJson } from "../shared.js";
import { catalogIdentity, type Catalog } from "../../layout/index.js";
import type { VendorEmitContext } from "../../vendor/schema.js";

export const EXTENSION_KEY = "claude";
export const PLUGIN_MANIFEST_REL = ".claude-plugin/plugin.json";
export const CATALOG_REL = ".claude-plugin/marketplace.json";

export async function emitPluginManifest(ctx: VendorEmitContext): Promise<void> {
  const { manifest } = ctx.plugin;
  await writeJson(join(ctx.pluginOutDir, PLUGIN_MANIFEST_REL), {
    ...withoutExtensions(manifest),
    ...extensionBlock(manifest, EXTENSION_KEY),
    ...pluginIdentity(manifest),
  });
}

export async function emitCatalog(vendorDir: string, catalog: Catalog): Promise<void> {
  await writeJson(join(vendorDir, CATALOG_REL), {
    ...catalogIdentity(catalog),
    ...(catalog.extensions[EXTENSION_KEY] ?? {}),
    ...catalogIdentity(catalog),
    plugins: catalog.plugins.map((plugin) => ({
      name: plugin.name,
      source: pluginSourcePath(plugin.name),
      description: plugin.manifest.description,
    })),
  });
}
