import { rm } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";

import { resolveRootsForRepo } from "./config/harness.js";
import { compilePlugins, loadAdapter } from "./compile/index.js";
import { compileConfigs } from "./configs/compile.js";
import { emitConfigsManifest } from "./configs/emit.js";
import { defaultSources, discoverInstalled, indexInstalled } from "./installed.js";
import { collectLocalIds } from "./layout/index.js";
import { resolveVendorsForRepo } from "./vendor/registry.js";
import type { Vendor } from "./vendor/schema.js";

export interface CompileOptions {
  readonly srcRoot?: string;
  readonly outRoot?: string;
  readonly silent?: boolean;
  readonly vendors?: readonly Vendor[];
  readonly repoRoot?: string;
}

export async function compile(options: CompileOptions = {}): Promise<void> {
  const srcRoot = resolve(options.srcRoot ?? "./src");
  const outRoot = resolve(options.outRoot ?? "./dist");
  const repoRoot = resolve(options.repoRoot ?? dirname(srcRoot));
  const vendors = options.vendors ?? (await resolveVendorsForRepo(repoRoot));
  const namedRoots = await resolveRootsForRepo(repoRoot);
  const adapter = await loadAdapter(srcRoot);
  const localIds = await collectLocalIds(adapter);
  const installedIndex = indexInstalled(await discoverInstalled(defaultSources(vendors)));

  for (const vendor of vendors) {
    await rm(vendor.vendorOutDir(outRoot), { recursive: true, force: true });
  }
  await rm(join(outRoot, "configs.json"), { force: true });

  await compilePlugins({
    srcRoot,
    outRoot,
    vendors,
    adapter,
    localIds,
    installedIndex,
    namedRoots,
    ...(options.silent ? {} : { onWarnings: reportWarningsToStderr }),
  });
  await compileConfigs({
    srcRoot,
    outRoot,
    vendors,
    localIds,
    installedIndex,
    namedRoots,
    ...(options.silent ? {} : { onWarnings: reportWarningsToStderr }),
  });
  await emitConfigsManifest({
    outRoot,
    vendors,
  });
  if (!options.silent) {
    console.log(`compiled → ${outRoot}`);
  }
}

function reportWarningsToStderr(filePath: string, warnings: readonly string[]): void {
  for (const warning of warnings) {
    console.warn(`warning: ${filePath}: ${warning}`);
  }
}
