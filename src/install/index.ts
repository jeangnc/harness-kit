import { resolve } from "node:path";

import { applyConfigLinks, formatPlannedLink, planConfigLinks } from "./links.js";
import { discoverPluginsForVendor, readMarketplaceName } from "./discovery.js";
import { defaultRunner, type CommandRunner } from "./runner.js";
import type { Vendor, VendorInstallContext } from "../vendor/schema.js";

export interface InstallOptions {
  readonly distRoot?: string;
  readonly repoRoot?: string;
  readonly vendors: readonly Vendor[];
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

interface ResolvedContext {
  readonly distRoot: string;
  readonly repoRoot: string;
  readonly vendors: readonly Vendor[];
  readonly marketplace: string;
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
  const marketplace = await readMarketplaceName(distRoot);
  return { distRoot, repoRoot, vendors: options.vendors, marketplace, run: runner, log };
}

function buildVendorContext(
  ctx: ResolvedContext,
  plugins: VendorInstallContext["plugins"],
): VendorInstallContext {
  return {
    distRoot: ctx.distRoot,
    marketplace: ctx.marketplace,
    plugins,
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
    ctx.log(`[dry-run] ${vendor.name}: would install ${plugins.length} plugin(s):`);
    for (const p of plugins) ctx.log(`  ${p.name}@${p.version}`);
  }
}
