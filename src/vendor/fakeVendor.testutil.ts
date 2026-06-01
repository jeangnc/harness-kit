import { join } from "node:path";

import type { Vendor } from "./schema.js";

export function makeFakeVendor(name: string, overrides: Partial<Vendor> = {}): Vendor {
  return {
    name,
    home: `/tmp/.${name}`,
    pluginManifestPath: `.${name}-plugin/plugin.json`,
    marketplaceManifestPath: `${name}/.${name}-plugin/marketplace.json`,
    vendorOutDir: (outRoot) => join(outRoot, name),
    pluginOutDir: (outRoot, pluginName) => join(outRoot, name, "plugins", pluginName),
    configsOutDir: (outRoot) => join(outRoot, name, "configs"),
    emitPluginManifest: async () => undefined,
    emitMarketplaceManifest: async () => undefined,
    install: async () => undefined,
    uninstall: async () => undefined,
    partitionPlugins: (ctx) => ({ enabled: ctx.plugins, disabled: [] }),
    ...overrides,
  };
}
