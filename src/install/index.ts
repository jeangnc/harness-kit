import { resolve } from "node:path";

import { applyConfigLinks, formatPlannedLink, planConfigLinks } from "./links.js";
import { discoverPluginsForVendor, readMarketplaceName } from "./discovery.js";
import { type InstallMode } from "./mode.js";
import { defaultRunner, type CommandRunner } from "./runner.js";
import { err, ok, type Result } from "../result.js";
import type { DiscoveredVendorPlugin, Vendor, VendorInstallContext } from "../vendor/schema.js";

export interface InstallOptions {
  readonly distRoot?: string;
  readonly repoRoot?: string;
  readonly vendors: readonly Vendor[];
  readonly mode?: InstallMode;
  readonly silent?: boolean;
  readonly dryRun?: boolean;
  readonly log?: (msg: string) => void;
}

export async function install(options: InstallOptions): Promise<void> {
  await installWithRunner(options, defaultRunner);
}

export async function uninstall(options: InstallOptions): Promise<void> {
  await uninstallWithRunner(options, defaultRunner);
}

export interface UpdateError {
  readonly kind: "not-installed";
}

export type PluginChange =
  | { readonly kind: "added"; readonly name: string; readonly to: string }
  | { readonly kind: "changed"; readonly name: string; readonly from: string; readonly to: string }
  | { readonly kind: "unchanged"; readonly name: string; readonly at: string }
  | { readonly kind: "removed"; readonly name: string; readonly from: string };

export interface UpdateReport {
  readonly changes: readonly PluginChange[];
}

export async function update(options: InstallOptions): Promise<Result<UpdateReport, UpdateError>> {
  return updateWithRunner(options, defaultRunner);
}

const UPDATE_ERROR_MESSAGES = {
  "not-installed": "harness is not installed; run `harness install` first",
} as const satisfies Record<UpdateError["kind"], string>;

export function formatUpdateError(error: UpdateError): string {
  return UPDATE_ERROR_MESSAGES[error.kind];
}

export async function installWithRunner(
  options: InstallOptions,
  runner: CommandRunner,
): Promise<void> {
  const ctx = await resolveContext(options, runner);
  if (options.dryRun) {
    await runDryRun(ctx);
    return;
  }
  await applyConfigLinks({ repoRoot: ctx.repoRoot, distRoot: ctx.distRoot, vendors: ctx.vendors });
  for (const vendor of ctx.vendors) {
    const plugins = await discoverPluginsForVendor(ctx.distRoot, vendor);
    await vendor.install(buildVendorContext(ctx, plugins));
  }
}

export async function uninstallWithRunner(
  options: InstallOptions,
  runner: CommandRunner,
): Promise<void> {
  const ctx = await resolveContext(options, runner);
  if (options.dryRun) {
    await runUninstallDryRun(ctx);
    return;
  }
  for (const vendor of ctx.vendors) {
    const plugins = await discoverPluginsForVendor(ctx.distRoot, vendor);
    await vendor.uninstall(buildVendorContext(ctx, plugins));
  }
}

export async function updateWithRunner(
  options: InstallOptions,
  runner: CommandRunner,
): Promise<Result<UpdateReport, UpdateError>> {
  const ctx = await resolveContext(options, runner);
  const candidates = await Promise.all(
    ctx.vendors.map(async (vendor) => {
      const plugins = await discoverPluginsForVendor(ctx.distRoot, vendor);
      const vendorCtx = buildVendorContext(ctx, plugins);
      return { vendor, plugins, vendorCtx, installed: await vendor.isInstalled(vendorCtx) };
    }),
  );
  const refreshable = candidates.filter((c) => c.installed);
  if (refreshable.length === 0) return err({ kind: "not-installed" });

  const changes: PluginChange[] = [];
  for (const { vendor, plugins, vendorCtx } of refreshable) {
    const before = await vendor.installedVersions(vendorCtx);
    changes.push(...diffPlugins({ before, shipped: plugins }));
    if (!options.dryRun) await vendor.refresh(vendorCtx);
  }
  for (const change of changes) ctx.log(formatPluginChange(change));
  return ok({ changes });
}

interface DiffInput {
  readonly before: ReadonlyMap<string, string>;
  readonly shipped: readonly DiscoveredVendorPlugin[];
}

function diffPlugins({ before, shipped }: DiffInput): readonly PluginChange[] {
  const shippedNames = new Set(shipped.map((p) => p.name));
  const changes: PluginChange[] = shipped.map((plugin) => {
    const from = before.get(plugin.name);
    if (from === undefined) return { kind: "added", name: plugin.name, to: plugin.version };
    if (from === plugin.version) return { kind: "unchanged", name: plugin.name, at: from };
    return { kind: "changed", name: plugin.name, from, to: plugin.version };
  });
  for (const [name, from] of before) {
    if (!shippedNames.has(name)) changes.push({ kind: "removed", name, from });
  }
  return changes;
}

function formatPluginChange(change: PluginChange): string {
  switch (change.kind) {
    case "added":
      return `[update] added ${change.name} ${change.to}`;
    case "changed":
      return `[update] ${change.name} ${change.from} → ${change.to}`;
    case "unchanged":
      return `[update] ${change.name} unchanged (${change.at})`;
    case "removed":
      return `[update] removed ${change.name} (was ${change.from})`;
  }
}

interface ResolvedContext {
  readonly distRoot: string;
  readonly repoRoot: string;
  readonly vendors: readonly Vendor[];
  readonly marketplace: string;
  readonly mode: InstallMode;
  readonly run: CommandRunner;
  readonly log: (msg: string) => void;
}

async function resolveContext(
  options: InstallOptions,
  runner: CommandRunner,
): Promise<ResolvedContext> {
  if (options.vendors.length === 0) {
    throw new Error("install requires at least one vendor");
  }
  const distRoot = resolve(options.distRoot ?? "./dist");
  const repoRoot = resolve(options.repoRoot ?? ".");
  const silent = options.silent ?? false;
  const log =
    options.log ??
    ((msg: string): void => {
      if (!silent) console.log(msg);
    });
  const marketplace = await resolveMarketplaceName(distRoot, options.vendors);
  const mode = options.mode ?? "local";
  return { distRoot, repoRoot, vendors: options.vendors, marketplace, mode, run: runner, log };
}

async function resolveMarketplaceName(
  distRoot: string,
  vendors: readonly Vendor[],
): Promise<string> {
  const names = await Promise.all(vendors.map(async (v) => readMarketplaceName(distRoot, v)));
  const [first, ...rest] = names;
  if (first === undefined) throw new Error("install requires at least one vendor");
  const mismatch = rest.find((n) => n !== first);
  if (mismatch !== undefined) {
    throw new Error(`vendor marketplaces disagree on name: got "${mismatch}", expected "${first}"`);
  }
  return first;
}

function buildVendorContext(
  ctx: ResolvedContext,
  plugins: VendorInstallContext["plugins"],
): VendorInstallContext {
  return {
    distRoot: ctx.distRoot,
    marketplace: ctx.marketplace,
    plugins,
    mode: ctx.mode,
    run: ctx.run,
    log: ctx.log,
  };
}

async function runUninstallDryRun(ctx: ResolvedContext): Promise<void> {
  for (const vendor of ctx.vendors) {
    const plugins = await discoverPluginsForVendor(ctx.distRoot, vendor);
    if (plugins.length === 0) {
      ctx.log(`[dry-run] ${vendor.name}: no plugins to uninstall`);
      continue;
    }
    ctx.log(`[dry-run] ${vendor.name}: would uninstall ${plugins.length} plugin(s):`);
    for (const p of plugins) ctx.log(`  ${p.name}@${p.version}`);
  }
}

async function runDryRun(ctx: ResolvedContext): Promise<void> {
  const plan = await planConfigLinks({
    repoRoot: ctx.repoRoot,
    distRoot: ctx.distRoot,
    vendors: ctx.vendors,
  });
  if (plan.length > 0) {
    ctx.log("[dry-run] config links:");
    for (const entry of plan) ctx.log(`  ${formatPlannedLink(entry, ctx.repoRoot)}`);
  }
  for (const vendor of ctx.vendors) {
    const plugins = await discoverPluginsForVendor(ctx.distRoot, vendor);
    if (plugins.length === 0) {
      ctx.log(`[dry-run] ${vendor.name}: no plugins`);
      continue;
    }
    const { enabled, disabled } = vendor.partitionPlugins(buildVendorContext(ctx, plugins));
    ctx.log(`[dry-run] ${vendor.name}: would install ${enabled.length} plugin(s):`);
    for (const p of enabled) ctx.log(`  ${p.name}@${p.version}`);
    for (const p of disabled) ctx.log(`  ${p.name}@${p.version} (skipped — disabled in settings)`);
  }
}
