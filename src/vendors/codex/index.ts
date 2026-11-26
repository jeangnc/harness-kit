import { homedir } from "node:os";
import { join, parse, resolve } from "node:path";

import { vendorBuild } from "../../layout/index.js";
import { defaultPartition } from "../shared.js";
import { CATALOG_REL, PLUGIN_MANIFEST_REL, emitCatalog, emitPluginManifest } from "./emit.js";
import type { Vendor, VendorInstallContext } from "../../vendor/schema.js";
import {
  installPlugin,
  listMarketplacePlugins,
  registerGitMarketplace,
  registerMarketplace,
  removeMarketplace,
  removePlugin,
  upgradeMarketplace,
} from "./native.js";
import type { Invocation } from "./native.js";

const VENDOR_NAME = "codex";

export function makeVendor(homePath: string): Vendor {
  const home = resolve(homePath);
  const inHome = (ctx: VendorInstallContext): Invocation => ({
    home,
    cwd: parse(home).root,
    run: ctx.run,
  });
  return {
    name: VENDOR_NAME,
    home,
    pluginManifestPath: PLUGIN_MANIFEST_REL,
    catalogPath: CATALOG_REL,
    runtimeLayout: { kind: "nested", directories: ["profiles", "hooks", "configs"] },
    pluginSelection: "native",
    configPlacement: () => null,
    emitPluginManifest: emitPluginManifest,
    emitCatalog: async (ctx) => emitCatalog(ctx.vendorDir, ctx.catalog),
    install: async (ctx) => refreshPlugins(ctx, inHome(ctx)),
    refresh: async (ctx) => refreshPlugins(ctx, inHome(ctx)),
    async uninstall(ctx) {
      const native = inHome(ctx);
      const entries = await listMarketplacePlugins({ ...native, marketplace: ctx.marketplace });
      for (const plugin of entries.filter((entry) => entry.installed)) {
        await removePlugin({ ...native, key: `${plugin.name}@${ctx.marketplace}` });
      }
      await removeMarketplace({ ...native, marketplace: ctx.marketplace });
    },
    partitionPlugins: defaultPartition,
    async pruneStale(ctx, names) {
      for (const name of names) {
        await removePlugin({ ...inHome(ctx), key: `${name}@${ctx.marketplace}` });
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

async function refreshPlugins(ctx: VendorInstallContext, native: Invocation): Promise<void> {
  const { source } = ctx;
  if (source.kind === "local") {
    await registerMarketplace({
      ...native,
      marketplace: { name: ctx.marketplace, path: vendorBuild(ctx.distRoot, VENDOR_NAME).root },
    });
  } else {
    await registerGitMarketplace({
      ...native,
      marketplace: { name: ctx.marketplace, repository: source.repository.slug, ref: VENDOR_NAME },
    });
    await upgradeMarketplace({ ...native, marketplace: ctx.marketplace });
  }
  const entries = await listMarketplacePlugins({ ...native, marketplace: ctx.marketplace });
  for (const plugin of ctx.plugins) {
    const entry = entries.find((candidate) => candidate.name === plugin.name);
    if (!entry?.enabled) {
      if (entry?.installed) {
        ctx.log(
          `[codex] skipped disabled ${plugin.name}@${entry.version}; enable it in Codex to receive ${plugin.version}`,
        );
      }
      continue;
    }
    await installPlugin({
      ...native,
      plugin: { key: `${plugin.name}@${ctx.marketplace}`, version: plugin.version },
    });
    ctx.log(`[codex] installed ${plugin.name} through Codex`);
  }
}

export const vendor: Vendor = makeVendor(process.env["CODEX_HOME"] ?? join(homedir(), ".codex"));
