import { homedir } from "node:os";
import { join, parse, resolve } from "node:path";

import {
  defaultEmitMarketplaceManifest,
  defaultEmitPluginManifest,
  defaultPartition,
} from "../shared.js";
import type { Vendor, VendorInstallContext } from "../../vendor/schema.js";
import {
  installCodexPlugin,
  listMarketplacePlugins,
  registerCodexMarketplace,
  removeCodexMarketplace,
  removeCodexPlugin,
  upgradeCodexMarketplace,
} from "./native.js";
import type { CodexNativeContext } from "./native.js";

const VENDOR_DIR = "codex";
const PLUGIN_MANIFEST_REL = ".codex-plugin/plugin.json";
const MARKETPLACE_MANIFEST_REL = `${VENDOR_DIR}/.claude-plugin/marketplace.json`;

export function makeCodexVendor(homePath: string): Vendor {
  const home = resolve(homePath);
  const inHome = (ctx: VendorInstallContext): CodexNativeContext => ({
    home,
    cwd: parse(home).root,
    run: ctx.run,
  });
  return {
    name: "codex",
    home,
    pluginManifestPath: PLUGIN_MANIFEST_REL,
    marketplaceManifestPath: MARKETPLACE_MANIFEST_REL,
    vendorOutDir: (outRoot) => join(outRoot, VENDOR_DIR),
    pluginOutDir: (outRoot, pluginName) => join(outRoot, VENDOR_DIR, "plugins", pluginName),
    configsOutDir: (outRoot) => join(outRoot, VENDOR_DIR, "configs"),
    configPlacement: () => null,
    emitPluginManifest: async (ctx) => defaultEmitPluginManifest(PLUGIN_MANIFEST_REL, ctx),
    emitMarketplaceManifest: async (ctx) =>
      defaultEmitMarketplaceManifest(MARKETPLACE_MANIFEST_REL, ctx),
    install: async (ctx) => refreshPlugins(ctx, inHome(ctx)),
    refresh: async (ctx) => refreshPlugins(ctx, inHome(ctx)),
    async uninstall(ctx) {
      const native = inHome(ctx);
      const entries = await listMarketplacePlugins({ ...native, marketplace: ctx.marketplace });
      for (const plugin of entries.filter((entry) => entry.installed)) {
        await removeCodexPlugin({ ...native, key: `${plugin.name}@${ctx.marketplace}` });
      }
      await removeCodexMarketplace({ ...native, marketplace: ctx.marketplace });
    },
    partitionPlugins: defaultPartition,
    async pruneStale(ctx, names) {
      for (const name of names) {
        await removeCodexPlugin({ ...inHome(ctx), key: `${name}@${ctx.marketplace}` });
      }
    },
    async isInstalled(ctx) {
      return (await listMarketplacePlugins({ ...inHome(ctx), marketplace: ctx.marketplace })).some(
        (entry) => entry.installed,
      );
    },
    async installedVersions(ctx) {
      return new Map(
        (await listMarketplacePlugins({ ...inHome(ctx), marketplace: ctx.marketplace }))
          .filter((entry) => entry.installed)
          .map((entry) => [entry.name, entry.version]),
      );
    },
  };
}

async function refreshPlugins(
  ctx: VendorInstallContext,
  native: CodexNativeContext,
): Promise<void> {
  if (ctx.mode === "local") {
    await registerCodexMarketplace({
      ...native,
      marketplace: { name: ctx.marketplace, path: join(ctx.distRoot, VENDOR_DIR) },
    });
  } else {
    await upgradeCodexMarketplace({ ...native, marketplace: ctx.marketplace });
  }
  const entries = await listMarketplacePlugins({ ...native, marketplace: ctx.marketplace });
  for (const plugin of ctx.plugins) {
    const entry = entries.find((candidate) => candidate.name === plugin.name);
    if (entry?.installed && entry.version === plugin.version) continue;
    if (!entry?.enabled) {
      if (entry?.installed) {
        ctx.log(
          `[codex] skipped disabled ${plugin.name}@${entry.version}; enable it in Codex to receive ${plugin.version}`,
        );
      }
      continue;
    }
    await installCodexPlugin({
      ...native,
      plugin: { key: `${plugin.name}@${ctx.marketplace}`, version: plugin.version },
    });
    ctx.log(`[codex] installed ${plugin.name} through Codex`);
  }
}

export const codexVendor: Vendor = makeCodexVendor(
  process.env["CODEX_HOME"] ?? join(homedir(), ".codex"),
);
