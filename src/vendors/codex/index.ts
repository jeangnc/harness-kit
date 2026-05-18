import { homedir } from "node:os";
import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import { runIgnoreFailure } from "../../install/runner.js";
import { writeVendorPluginManifest } from "../shared.js";
import type { Vendor, VendorEmitContext, VendorInstallContext } from "../../vendor/schema.js";

const MANIFEST_REL = ".codex-plugin/plugin.json";

export function makeCodexVendor(home: string): Vendor {
  return {
    name: "codex",
    home,
    pluginManifestPath: MANIFEST_REL,
    async emitPluginManifest(ctx: VendorEmitContext): Promise<void> {
      await writeVendorPluginManifest(ctx.pluginOutDir, MANIFEST_REL, ctx.manifest);
    },
    async install(ctx: VendorInstallContext): Promise<void> {
      if (ctx.plugins.length === 0) return;
      ctx.log(`[codex] priming ${ctx.plugins.length} plugin(s) on marketplace ${ctx.marketplace}`);
      await rm(join(home, "plugins/cache", ctx.marketplace), { recursive: true, force: true });
      await runIgnoreFailure(ctx.run, "codex", ["plugin", "marketplace", "add", ctx.distRoot]);
      for (const plugin of ctx.plugins) {
        const dest = join(home, "plugins/cache", ctx.marketplace, plugin.name, plugin.version);
        await mkdir(dirname(dest), { recursive: true });
        await cp(plugin.path, dest, { recursive: true });
        ctx.log(`[codex] cached ${plugin.name}@${plugin.version}`);
      }
    },
    async uninstall(ctx: VendorInstallContext): Promise<void> {
      await runIgnoreFailure(ctx.run, "codex", [
        "plugin",
        "marketplace",
        "remove",
        ctx.marketplace,
      ]);
      await rm(join(home, "plugins/cache", ctx.marketplace), { recursive: true, force: true });
      ctx.log(`[codex] removed ${ctx.marketplace} cache`);
    },
  };
}

export const codexVendor: Vendor = makeCodexVendor(join(homedir(), ".codex"));
