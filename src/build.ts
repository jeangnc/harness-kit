import { rm } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";

import { compile, type BodyInvariant } from "./compile/index.js";
import { emitConfigsManifest } from "./configs/emit.js";
import { resolveVendorsForRepo } from "./vendor/registry.js";
import type { Vendor } from "./vendor/schema.js";

export interface BuildOptions {
  readonly srcRoot?: string;
  readonly outRoot?: string;
  readonly bodyInvariants?: readonly BodyInvariant[];
  readonly silent?: boolean;
  readonly vendors?: readonly Vendor[];
  readonly repoRoot?: string;
}

export async function build(options: BuildOptions = {}): Promise<void> {
  const srcRoot = resolve(options.srcRoot ?? "./src");
  const outRoot = resolve(options.outRoot ?? "./dist");
  const repoRoot = resolve(options.repoRoot ?? dirname(srcRoot));
  const vendors = options.vendors ?? (await resolveVendorsForRepo(repoRoot));
  for (const vendor of vendors) {
    await rm(vendor.vendorOutDir(outRoot), { recursive: true, force: true });
    await rm(join(outRoot, dirname(vendor.marketplaceManifestPath)), {
      recursive: true,
      force: true,
    });
  }
  await rm(join(outRoot, "configs.json"), { force: true });
  await compile({
    srcRoot,
    outRoot,
    vendors,
    ...(options.bodyInvariants ? { bodyInvariants: options.bodyInvariants } : {}),
  });
  await emitConfigsManifest({
    srcRoot,
    outRoot,
    vendors: vendors.map((v) => v.name),
  });
  if (!options.silent) {
    console.log(`compiled → ${outRoot}`);
  }
}
