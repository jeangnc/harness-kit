import { homedir } from "node:os";
import { join, parse, resolve } from "node:path";
import { z } from "zod";

import {
  defaultEmitMarketplaceManifest,
  defaultEmitPluginManifest,
  defaultPartition,
} from "../shared.js";
import type { Vendor, VendorInstallContext } from "../../vendor/schema.js";

const VENDOR_DIR = "codex";
const PLUGIN_MANIFEST_REL = ".codex-plugin/plugin.json";
const MARKETPLACE_MANIFEST_REL = `${VENDOR_DIR}/.claude-plugin/marketplace.json`;
const pluginEntry = z.object({
  name: z.string(),
  marketplaceName: z.string(),
  version: z.string(),
  installed: z.boolean(),
  enabled: z.boolean(),
});
const pluginList = z.object({
  installed: z.array(pluginEntry),
  available: z.array(pluginEntry),
});

export function makeCodexVendor(homePath: string): Vendor {
  const home = resolve(homePath);
  const inHome = (ctx: VendorInstallContext): VendorInstallContext => ({
    ...ctx,
    run: async (cmd, args) =>
      ctx.run(cmd, args, { env: { CODEX_HOME: home }, cwd: parse(resolve(home)).root }),
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
    install: async (ctx) => refreshPlugins(inHome(ctx)),
    refresh: async (ctx) => refreshPlugins(inHome(ctx)),
    async uninstall(context) {
      const ctx = inHome(context);
      for (const plugin of (await listPlugins(ctx)).filter((entry) => entry.installed)) {
        await removePlugin(ctx, plugin.name);
      }
      await ctx.run("codex", ["plugin", "marketplace", "remove", ctx.marketplace, "--json"]);
    },
    partitionPlugins: defaultPartition,
    async pruneStale(context, names) {
      const ctx = inHome(context);
      for (const name of names) await removePlugin(ctx, name);
    },
    async isInstalled(ctx) {
      return (await listPlugins(inHome(ctx))).some((entry) => entry.installed);
    },
    async installedVersions(ctx) {
      return new Map(
        (await listPlugins(inHome(ctx)))
          .filter((entry) => entry.installed)
          .map((entry) => [entry.name, entry.version]),
      );
    },
  };
}

async function refreshPlugins(ctx: VendorInstallContext): Promise<void> {
  if (ctx.mode === "local") {
    await ctx.run("codex", [
      "plugin",
      "marketplace",
      "add",
      join(ctx.distRoot, VENDOR_DIR),
      "--json",
    ]);
  } else {
    const output = await ctx.run("codex", [
      "plugin",
      "marketplace",
      "upgrade",
      ctx.marketplace,
      "--json",
    ]);
    const result = z.object({ errors: z.array(z.unknown()) }).parse(JSON.parse(output ?? ""));
    if (result.errors.length > 0) {
      throw new Error(
        "Codex marketplace upgrade failed; inspect its configured Git source before retrying",
      );
    }
  }
  const entries = await listPlugins(ctx);
  for (const plugin of ctx.plugins) {
    const installed = entries.find((entry) => entry.name === plugin.name && entry.installed);
    if (installed && !installed.enabled && installed.version !== plugin.version) {
      throw new Error(
        `Codex cannot refresh disabled plugin ${plugin.name} without enabling it; leave its installed version unchanged or enable it through Codex first`,
      );
    }
  }
  for (const plugin of ctx.plugins) {
    const entry = entries.find((candidate) => candidate.name === plugin.name);
    if (!entry?.enabled || (entry.installed && entry.version === plugin.version)) continue;
    const output = await ctx.run("codex", [
      "plugin",
      "add",
      `${plugin.name}@${ctx.marketplace}`,
      "--json",
    ]);
    const result = z.object({ version: z.string() }).parse(JSON.parse(output ?? ""));
    if (result.version !== plugin.version) {
      throw new Error(
        `Codex installed ${plugin.name}@${result.version}; expected ${plugin.name}@${plugin.version}`,
      );
    }
    ctx.log(`[codex] installed ${plugin.name} through Codex`);
  }
}

async function listPlugins(ctx: VendorInstallContext): Promise<Array<z.infer<typeof pluginEntry>>> {
  const output = await ctx.run("codex", [
    "plugin",
    "list",
    "--marketplace",
    ctx.marketplace,
    "--available",
    "--json",
  ]);
  try {
    const result = pluginList.parse(JSON.parse(output ?? ""));
    return [...result.installed, ...result.available].filter(
      (entry) => entry.marketplaceName === ctx.marketplace,
    );
  } catch (cause) {
    throw new Error("Codex plugin list did not return the expected native JSON registry", {
      cause,
    });
  }
}

async function removePlugin(ctx: VendorInstallContext, name: string): Promise<void> {
  await ctx.run("codex", ["plugin", "remove", `${name}@${ctx.marketplace}`, "--json"]);
}

export const codexVendor: Vendor = makeCodexVendor(
  process.env["CODEX_HOME"] ?? join(homedir(), ".codex"),
);
