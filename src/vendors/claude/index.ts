import { homedir } from "node:os";
import { rm } from "node:fs/promises";
import { join } from "node:path";

import { runIgnoreFailure } from "../../install/runner.js";
import { writeVendorPluginManifest } from "../shared.js";
import type {
  LinkedFile,
  Vendor,
  VendorEmitContext,
  VendorInstallContext,
} from "../../vendor/schema.js";

const MANIFEST_REL = ".claude-plugin/plugin.json";

export function makeClaudeVendor(home: string): Vendor {
  return {
    name: "claude",
    home,
    pluginManifestPath: MANIFEST_REL,
    aliases(file: LinkedFile): readonly string[] {
      return file.basename === "AGENTS.md" ? [join(home, "CLAUDE.md")] : [];
    },
    async emitPluginManifest(ctx: VendorEmitContext): Promise<void> {
      await writeVendorPluginManifest(ctx.pluginOutDir, MANIFEST_REL, ctx.manifest);
    },
    async install(ctx: VendorInstallContext): Promise<void> {
      if (ctx.plugins.length === 0) return;
      ctx.log(
        `[claude] refreshing ${ctx.plugins.length} plugin(s) on marketplace ${ctx.marketplace}`,
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

export const claudeVendor: Vendor = makeClaudeVendor(join(homedir(), ".claude"));
