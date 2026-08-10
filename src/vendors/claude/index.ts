import { homedir } from "node:os";
import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import { runIgnoreFailure } from "../../install/runner.js";
import { errnoCode, pathExists, readdirOrEmpty } from "../../fs.js";
import {
  patchInstalledEntries,
  readInstalledPlugins,
  removeInstalledEntries,
  writeInstalledPlugins,
} from "./installedPlugins.js";
import type { InstalledPlugins } from "./installedPlugins.js";
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
const STAGING_ROOT_DIR = ".staging";
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
    if (errnoCode(cause) === "ENOENT") return new Set();
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
        `[claude] installing ${ctx.plugins.length} plugin(s) on marketplace ${ctx.marketplace} (${ctx.mode})`,
      );
      await refreshMarketplace(ctx);
      await pruneStagingDirs(home);
      ctx.log(`[claude] refreshed marketplace ${ctx.marketplace}`);
      for (const plugin of disabled) {
        ctx.log(`[claude] skipped ${plugin.name} (disabled in settings)`);
      }
      const installed = await readInstalledPlugins(home);
      const now = new Date().toISOString();
      for (const plugin of enabled) {
        const key = pluginKey(plugin.name, ctx.marketplace);
        if (installed.plugins[key] === undefined) {
          await ctx.run("claude", ["plugin", "install", key]);
          if ((await readInstalledPlugins(home)).plugins[key] === undefined) {
            throw new Error(
              `claude plugin install ${key} did not register the plugin; marketplace ${ctx.marketplace} may be unavailable`,
            );
          }
          ctx.log(`[claude] installed ${plugin.name}`);
        }
        await refreshPlugin(home, ctx, plugin, now);
      }
    },
    async refresh(ctx: VendorInstallContext): Promise<void> {
      if (ctx.plugins.length === 0) return;
      await refreshPlugins(home, ctx, new Date().toISOString());
    },
    async uninstall(ctx: VendorInstallContext): Promise<void> {
      for (const plugin of ctx.plugins) {
        await uninstallOne(ctx, plugin.name);
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
    async pruneStale(ctx: VendorInstallContext, names: readonly string[]): Promise<void> {
      for (const name of names) {
        await uninstallOne(ctx, name);
        const key = pluginKey(name, ctx.marketplace);
        await writeInstalledPlugins(
          home,
          removeInstalledEntries(await readInstalledPlugins(home), [key]),
        );
        await rm(join(cacheDir(home, ctx.marketplace), name), { recursive: true, force: true });
      }
    },
    async isInstalled(ctx: VendorInstallContext): Promise<boolean> {
      const cached = await readdirOrEmpty(cacheDir(home, ctx.marketplace));
      return cached.length > 0;
    },
    async installedVersions(ctx: VendorInstallContext): Promise<ReadonlyMap<string, string>> {
      const root = cacheDir(home, ctx.marketplace);
      const versions = new Map<string, string>();
      for (const name of await readdirOrEmpty(root)) {
        const cached: string[] = [];
        for (const version of await readdirOrEmpty(join(root, name))) {
          if (await pathExists(join(root, name, version, PLUGIN_MANIFEST_REL))) {
            cached.push(version);
          }
        }
        const latest = cached
          .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
          .at(-1);
        if (latest !== undefined) versions.set(name, latest);
      }
      return versions;
    },
  };
}

async function uninstallOne(ctx: VendorInstallContext, name: string): Promise<void> {
  await runIgnoreFailure(ctx.run, "claude", [
    "plugin",
    "uninstall",
    pluginKey(name, ctx.marketplace),
  ]);
}

async function refreshPlugins(home: string, ctx: VendorInstallContext, now: string): Promise<void> {
  const registry = await readInstalledPlugins(home);
  for (const plugin of ctx.plugins) {
    if (registry.plugins[pluginKey(plugin.name, ctx.marketplace)] === undefined) {
      ctx.log(`[claude] skipped ${plugin.name} (not installed)`);
      continue;
    }
    await refreshPlugin(home, ctx, plugin, now);
  }
}

async function refreshPlugin(
  home: string,
  ctx: VendorInstallContext,
  plugin: DiscoveredVendorPlugin,
  now: string,
): Promise<void> {
  const key = pluginKey(plugin.name, ctx.marketplace);
  const dest = versionedCacheDir(home, ctx.marketplace, plugin.name, plugin.version);
  await stageIntoPlace(home, plugin.path, dest);
  const patched = patchInstalledEntries(await readInstalledPlugins(home), key, {
    installPath: dest,
    version: plugin.version,
    lastUpdated: now,
  });
  await writeInstalledPlugins(home, patched);
  await pruneOtherVersions(home, ctx.marketplace, plugin.name, dest, referencedPaths(patched));
  ctx.log(`[claude] refreshed ${plugin.name}@${plugin.version}`);
}

export async function stageIntoPlace(home: string, source: string, dest: string): Promise<void> {
  const root = await stagingRoot(home);
  const incoming = await mkdtemp(join(root, "incoming-"));
  const staged = join(incoming, "payload");
  try {
    await cp(source, staged, { recursive: true });
  } catch (cause) {
    await rm(incoming, { recursive: true, force: true });
    throw new Error(`cannot copy plugin from ${source}`, { cause });
  }
  try {
    await mkdir(dirname(dest), { recursive: true });
    const displaced = await displace(root, dest);
    try {
      await rename(staged, dest);
    } catch (cause) {
      await restore(displaced, dest);
      throw new Error(`cannot stage plugin into ${dest}`, { cause });
    }
    await discard(displaced);
  } finally {
    await rm(incoming, { recursive: true, force: true });
  }
}

async function displace(root: string, dest: string): Promise<string | null> {
  if (!(await pathExists(dest))) return null;
  const holding = await mkdtemp(join(root, "displaced-"));
  try {
    await rename(dest, join(holding, "payload"));
  } catch (cause) {
    await rm(holding, { recursive: true, force: true });
    throw cause;
  }
  return holding;
}

async function restore(displaced: string | null, dest: string): Promise<void> {
  if (displaced === null) return;
  await rename(join(displaced, "payload"), dest);
  await rm(displaced, { recursive: true, force: true });
}

async function discard(displaced: string | null): Promise<void> {
  if (displaced === null) return;
  await rm(displaced, { recursive: true, force: true });
}

async function stagingRoot(home: string): Promise<string> {
  const root = join(home, "plugins", STAGING_ROOT_DIR);
  await mkdir(root, { recursive: true });
  return root;
}

async function pruneOtherVersions(
  home: string,
  marketplace: string,
  name: string,
  keep: string,
  referenced: ReadonlySet<string>,
): Promise<void> {
  const root = pluginCacheDir(home, marketplace, name);
  for (const entry of await readdirOrEmpty(root)) {
    const dir = join(root, entry);
    if (dir === keep || referenced.has(dir)) continue;
    await rm(dir, { recursive: true, force: true });
  }
}

function referencedPaths(registry: InstalledPlugins): ReadonlySet<string> {
  return new Set(
    Object.values(registry.plugins).flatMap((entries) => entries.map((e) => e.installPath)),
  );
}

function pluginCacheDir(home: string, marketplace: string, name: string): string {
  return join(home, "plugins/cache", marketplace, name);
}

function versionedCacheDir(
  home: string,
  marketplace: string,
  name: string,
  version: string,
): string {
  return join(pluginCacheDir(home, marketplace, name), version);
}

function cacheDir(home: string, marketplace: string): string {
  return join(home, "plugins/cache", marketplace);
}

const STAGING_DIR_PATTERN = /^temp_\d+$/;

async function pruneStagingDirs(home: string): Promise<void> {
  const marketplacesDir = join(home, "plugins/marketplaces");
  for (const entry of await readdirOrEmpty(marketplacesDir)) {
    if (!STAGING_DIR_PATTERN.test(entry)) continue;
    await rm(join(marketplacesDir, entry), { recursive: true, force: true }).catch(() => undefined);
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
