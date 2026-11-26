import { join } from "node:path";

import type { Vendor } from "./schema.js";

export function makeFakeVendor(name: string, overrides: Partial<Vendor> = {}): Vendor {
  const home = overrides.home ?? `/tmp/.${name}`;
  return {
    name,
    home,
    pluginManifestPath: `.${name}-plugin/plugin.json`,
    catalogPath: `.${name}-plugin/marketplace.json`,
    configPlacement: (destRel) => ({ strategy: "link", destAbs: join(home, destRel) }),
    emitPluginManifest: async () => undefined,
    emitCatalog: async () => undefined,
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
