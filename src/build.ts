import { rm } from "node:fs/promises";

import { resolveRootsForRepo } from "./config/harness.js";
import { compilePlugins } from "./compile/index.js";
import { compileConfigs } from "./configs/compile.js";
import { emitConfigsManifest } from "./configs/emit.js";
import { assertRuntimeDetached } from "./install/runtime.js";
import { defaultSources, discoverInstalled, indexInstalled } from "./installed.js";
import { layoutAt, loadCatalogOrThrow } from "./layout/index.js";
import { resolveVendorsForRepo } from "./vendor/registry.js";
import type { Vendor } from "./vendor/schema.js";

export interface BuildOptions {
  readonly repoRoot?: string;
  readonly silent?: boolean;
  readonly vendors?: readonly Vendor[];
}

export async function build(options: BuildOptions = {}): Promise<void> {
  const layout = layoutAt(options.repoRoot ?? ".");
  const outRoot = layout.buildDir;
  const vendors = options.vendors ?? (await resolveVendorsForRepo(layout.repoRoot));
  await assertRuntimeDetached({ distRoot: outRoot, vendors });
  const namedRoots = await resolveRootsForRepo(layout.repoRoot);
  const catalog = await loadCatalogOrThrow(layout);
  const installedIndex = indexInstalled(await discoverInstalled(defaultSources(vendors)));
  const onWarnings = options.silent ? {} : { onWarnings: reportWarningsToStderr };

  await rm(outRoot, { recursive: true, force: true });
  await compilePlugins({
    layout,
    vendors,
    catalog,
    installedIndex,
    namedRoots,
    ...onWarnings,
  });
  await compileConfigs({ layout, vendors, catalog, installedIndex, namedRoots, ...onWarnings });
  await emitConfigsManifest({ outRoot, vendors });
  if (!options.silent) {
    console.log(`built → ${outRoot}`);
  }
}

function reportWarningsToStderr(filePath: string, warnings: readonly string[]): void {
  for (const warning of warnings) {
    console.warn(`warning: ${filePath}: ${warning}`);
  }
}
