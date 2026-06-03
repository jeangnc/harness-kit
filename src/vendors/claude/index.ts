import { homedir } from "node:os";
import { readFileSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { runIgnoreFailure } from "../../install/runner.js";
import { readdirOrEmpty } from "../../fs.js";
import { defaultEmitMarketplaceManifest, defaultEmitPluginManifest } from "../shared.js";
import type {
  DiscoveredVendorPlugin,
  LinkedFile,
  PluginPartition,
  Vendor,
  VendorEmitContext,
  VendorInstallContext,
  VendorMarketplaceEmitContext,
} from "../../vendor/schema.js";

const VENDOR_DIR = "claude";
const PLUGIN_MANIFEST_REL = ".claude-plugin/plugin.json";
const MARKETPLACE_MANIFEST_REL = `${VENDOR_DIR}/.claude-plugin/marketplace.json`;

function pluginKey(name: string, marketplace: string): string {
  return `${name}@${marketplace}`;
}

export function readDisabledPluginKeys(configsDir: string): ReadonlySet<string> {
  const settingsPath = join(configsDir, "settings.json");
  let raw: string;
  try {
    raw = readFileSync(settingsPath, "utf8");
  } catch (cause) {
    if (isErrno(cause) && cause.code === "ENOENT") return new Set();
    throw new Error(`cannot read claude settings.json at ${settingsPath}`, { cause });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error(`invalid claude settings.json at ${settingsPath}`, { cause });
  }
  const enabledPlugins = isRecord(parsed) ? parsed["enabledPlugins"] : undefined;
  if (enabledPlugins === undefined) return new Set();
  if (!isRecord(enabledPlugins)) {
    throw new Error(`claude settings.json "enabledPlugins" must be an object at ${settingsPath}`);
  }
  const disabled = new Set<string>();
  for (const [key, value] of Object.entries(enabledPlugins)) {
    if (typeof value !== "boolean") {
      throw new Error(
        `claude settings.json enabledPlugins[${JSON.stringify(key)}] must be a boolean at ${settingsPath}`,
      );
    }
    if (!value) disabled.add(key);
  }
  return disabled;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isErrno(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}

function partitionByEnabled(ctx: VendorInstallContext): PluginPartition {
  const disabledKeys = readDisabledPluginKeys(join(ctx.distRoot, VENDOR_DIR, "configs"));
  const enabled: DiscoveredVendorPlugin[] = [];
  const disabled: DiscoveredVendorPlugin[] = [];
  for (const plugin of ctx.plugins) {
    const bucket = disabledKeys.has(pluginKey(plugin.name, ctx.marketplace)) ? disabled : enabled;
    bucket.push(plugin);
  }
  return { enabled, disabled };
}

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
      const { enabled, disabled } = partitionByEnabled(ctx);
      ctx.log(
        `[claude] refreshing ${ctx.plugins.length} plugin(s) on marketplace ${ctx.marketplace} (${ctx.mode})`,
      );
      for (const plugin of ctx.plugins) {
        await runIgnoreFailure(ctx.run, "claude", [
          "plugin",
          "uninstall",
          pluginKey(plugin.name, ctx.marketplace),
        ]);
        await rm(join(cacheDir(home, ctx.marketplace), plugin.name), {
          recursive: true,
          force: true,
        });
      }
      await refreshMarketplace(ctx);
      ctx.log(`[claude] refreshed marketplace ${ctx.marketplace}`);
      for (const plugin of disabled) {
        ctx.log(`[claude] skipped ${plugin.name} (disabled in settings)`);
      }
      for (const plugin of enabled) {
        await ctx.run("claude", ["plugin", "install", pluginKey(plugin.name, ctx.marketplace)]);
        ctx.log(`[claude] installed ${plugin.name}`);
      }
    },
    async uninstall(ctx: VendorInstallContext): Promise<void> {
      for (const plugin of ctx.plugins) {
        await runIgnoreFailure(ctx.run, "claude", [
          "plugin",
          "uninstall",
          pluginKey(plugin.name, ctx.marketplace),
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
    partitionPlugins: partitionByEnabled,
    async isInstalled(ctx: VendorInstallContext): Promise<boolean> {
      const cached = await readdirOrEmpty(cacheDir(home, ctx.marketplace));
      return cached.length > 0;
    },
    async installedVersions(ctx: VendorInstallContext): Promise<ReadonlyMap<string, string>> {
      const root = cacheDir(home, ctx.marketplace);
      const versions = new Map<string, string>();
      for (const name of await readdirOrEmpty(root)) {
        const version = await readManifestVersion(join(root, name, PLUGIN_MANIFEST_REL));
        if (version !== undefined) versions.set(name, version);
      }
      return versions;
    },
  };
}

function cacheDir(home: string, marketplace: string): string {
  return join(home, "plugins/cache", marketplace);
}

async function readManifestVersion(manifestPath: string): Promise<string | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
    const version = isRecord(parsed) ? parsed["version"] : undefined;
    return typeof version === "string" ? version : undefined;
  } catch {
    return undefined;
  }
}

async function refreshMarketplace(ctx: VendorInstallContext): Promise<void> {
  const args =
    ctx.mode === "local"
      ? ["plugin", "marketplace", "add", join(ctx.distRoot, VENDOR_DIR), "--scope", "local"]
      : ["plugin", "marketplace", "update", ctx.marketplace];
  await runIgnoreFailure(ctx.run, "claude", args);
}

export const claudeVendor: Vendor = makeClaudeVendor(join(homedir(), ".claude"));
