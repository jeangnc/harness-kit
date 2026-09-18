import { join } from "node:path";

import type { Vendor } from "./schema.js";

export function makeFakeVendor(name: string, overrides: Partial<Vendor> = {}): Vendor {
  const home = overrides.home ?? `/tmp/.${name}`;
  return {
    name,
    home,
    pluginManifestPath: `.${name}-plugin/plugin.json`,
    marketplaceManifestPath: `${name}/.${name}-plugin/marketplace.json`,
    vendorOutDir: (outRoot) => join(outRoot, name),
    pluginOutDir: (outRoot, pluginName) => join(outRoot, name, "plugins", pluginName),
    configsOutDir: (outRoot) => join(outRoot, name, "configs"),
    configPlacement: (destRel) => ({ strategy: "link", destAbs: join(home, destRel) }),
    emitPluginManifest: async () => undefined,
    emitMarketplaceManifest: async () => undefined,
    install: async () => undefined,
    refresh: async () => undefined,
    uninstall: async () => undefined,
    partitionPlugins: (ctx) => ({ enabled: ctx.plugins, disabled: [] }),
    isInstalled: async () => true,
    installedVersions: async () => new Map(),
    pruneStale: async () => undefined,
    ...overrides,
  };
}
