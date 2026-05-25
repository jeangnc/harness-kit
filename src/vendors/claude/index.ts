import { homedir } from "node:os";
import { rm } from "node:fs/promises";
import { join } from "node:path";

import { runIgnoreFailure } from "../../install/runner.js";
import { defaultEmitMarketplaceManifest, defaultEmitPluginManifest } from "../shared.js";
import type {
  LinkedFile,
  Vendor,
  VendorEmitContext,
  VendorInstallContext,
  VendorMarketplaceEmitContext,
} from "../../vendor/schema.js";

const VENDOR_DIR = "claude";
const PLUGIN_MANIFEST_REL = ".claude-plugin/plugin.json";
const MARKETPLACE_MANIFEST_REL = `${VENDOR_DIR}/.claude-plugin/marketplace.json`;

export function makeClaudeVendor(home: string): Vendor {
  return {
    name: "claude",
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
    aliases(file: LinkedFile): readonly string[] {
      return file.basename === "AGENTS.md" ? [join(home, "CLAUDE.md")] : [];
    },
    async emitPluginManifest(ctx: VendorEmitContext): Promise<void> {
      await defaultEmitPluginManifest(PLUGIN_MANIFEST_REL, ctx);
    },
    async emitMarketplaceManifest(ctx: VendorMarketplaceEmitContext): Promise<void> {
      await defaultEmitMarketplaceManifest(MARKETPLACE_MANIFEST_REL, ctx);
    },
    async install(ctx: VendorInstallContext): Promise<void> {
      if (ctx.plugins.length === 0) return;
      ctx.log(
        `[claude] refreshing ${ctx.plugins.length} plugin(s) on marketplace ${ctx.marketplace} (${ctx.mode})`,
      );
      for (const plugin of ctx.plugins) {
        await runIgnoreFailure(ctx.run, "claude", [
          "plugin",
          "uninstall",
          `${plugin.name}@${ctx.marketplace}`,
        ]);
        await rm(join(home, "plugins/cache", ctx.marketplace, plugin.name), {
          recursive: true,
          force: true,
        });
      }
      await refreshMarketplace(ctx);
      ctx.log(`[claude] refreshed marketplace ${ctx.marketplace}`);
      for (const plugin of ctx.plugins) {
        await ctx.run("claude", ["plugin", "install", `${plugin.name}@${ctx.marketplace}`]);
        ctx.log(`[claude] installed ${plugin.name}`);
      }
    },
    async uninstall(ctx: VendorInstallContext): Promise<void> {
      for (const plugin of ctx.plugins) {
        await runIgnoreFailure(ctx.run, "claude", [
          "plugin",
          "uninstall",
          `${plugin.name}@${ctx.marketplace}`,
        ]);
        ctx.log(`[claude] uninstalled ${plugin.name}`);
      }
      await runIgnoreFailure(ctx.run, "claude", [
        "plugin",
        "marketplace",
        "remove",
        ctx.marketplace,
      ]);
    },
  };
}

async function refreshMarketplace(ctx: VendorInstallContext): Promise<void> {
  const args =
    ctx.mode === "local"
      ? ["plugin", "marketplace", "add", join(ctx.distRoot, VENDOR_DIR), "--scope", "local"]
      : ["plugin", "marketplace", "update", ctx.marketplace];
  await runIgnoreFailure(ctx.run, "claude", args);
}

export const claudeVendor: Vendor = makeClaudeVendor(join(homedir(), ".claude"));
