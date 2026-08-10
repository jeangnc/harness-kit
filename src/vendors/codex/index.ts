import { homedir } from "node:os";
import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import { runIgnoreFailure } from "../../install/runner.js";
import { readdirOrEmpty } from "../../fs.js";
import {
  defaultEmitMarketplaceManifest,
  defaultEmitPluginManifest,
  defaultPartition,
} from "../shared.js";
import type {
  Vendor,
  VendorEmitContext,
  VendorInstallContext,
  VendorMarketplaceEmitContext,
} from "../../vendor/schema.js";

const VENDOR_DIR = "codex";
const PLUGIN_MANIFEST_REL = ".codex-plugin/plugin.json";
const MARKETPLACE_MANIFEST_REL = `${VENDOR_DIR}/.codex-plugin/marketplace.json`;

export function makeCodexVendor(home: string): Vendor {
  return {
    name: "codex",
    home,
    pluginManifestPath: PLUGIN_MANIFEST_REL,
    marketplaceManifestPath: MARKETPLACE_MANIFEST_REL,
    vendorOutDir(outRoot) {
      return join(outRoot, VENDOR_DIR);
    },
    pluginOutDir(outRoot, pluginName) {
      return join(outRoot, VENDOR_DIR, "plugins", pluginName);
    },
    configsOutDir(outRoot) {
      return join(outRoot, VENDOR_DIR, "configs");
    },
    async emitPluginManifest(ctx: VendorEmitContext): Promise<void> {
      await defaultEmitPluginManifest(PLUGIN_MANIFEST_REL, ctx);
    },
    async emitMarketplaceManifest(ctx: VendorMarketplaceEmitContext): Promise<void> {
      await defaultEmitMarketplaceManifest(MARKETPLACE_MANIFEST_REL, ctx);
    },
    async install(ctx: VendorInstallContext): Promise<void> {
      await primeCache(home, ctx);
    },
    async refresh(ctx: VendorInstallContext): Promise<void> {
      await primeCache(home, ctx);
    },
    async uninstall(ctx: VendorInstallContext): Promise<void> {
      await runIgnoreFailure(ctx.run, "codex", [
        "plugin",
        "marketplace",
        "remove",
        ctx.marketplace,
      ]);
      await rm(cacheDir(home, ctx.marketplace), { recursive: true, force: true });
      ctx.log(`[codex] removed ${ctx.marketplace} cache`);
    },
    partitionPlugins: defaultPartition,
    async pruneStale(ctx: VendorInstallContext, names: readonly string[]): Promise<void> {
      for (const name of names) {
        await rm(join(cacheDir(home, ctx.marketplace), name), { recursive: true, force: true });
      }
    },
    async isInstalled(ctx: VendorInstallContext): Promise<boolean> {
      const entries = await readdirOrEmpty(cacheDir(home, ctx.marketplace));
      return entries.length > 0;
    },
    async installedVersions(ctx: VendorInstallContext): Promise<ReadonlyMap<string, string>> {
      const root = cacheDir(home, ctx.marketplace);
      const versions = new Map<string, string>();
      for (const name of await readdirOrEmpty(root)) {
        const [version] = await readdirOrEmpty(join(root, name));
        if (version !== undefined) versions.set(name, version);
      }
      return versions;
    },
  };
}

async function primeCache(home: string, ctx: VendorInstallContext): Promise<void> {
  if (ctx.plugins.length === 0) return;
  ctx.log(`[codex] priming ${ctx.plugins.length} plugin(s) on marketplace ${ctx.marketplace}`);
  await rm(cacheDir(home, ctx.marketplace), { recursive: true, force: true });
  await runIgnoreFailure(ctx.run, "codex", ["plugin", "marketplace", "add", ctx.distRoot]);
  for (const plugin of ctx.plugins) {
    const dest = join(cacheDir(home, ctx.marketplace), plugin.name, plugin.version);
    await mkdir(dirname(dest), { recursive: true });
    await cp(plugin.path, dest, { recursive: true });
    ctx.log(`[codex] cached ${plugin.name}@${plugin.version}`);
  }
}

function cacheDir(home: string, marketplace: string): string {
  return join(home, "plugins/cache", marketplace);
}

export const codexVendor: Vendor = makeCodexVendor(join(homedir(), ".codex"));
