import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { buildConfigsManifest } from "./manifest.js";
import type { Vendor } from "../vendor/schema.js";

export interface EmitConfigsManifestOptions {
  readonly outRoot: string;
  readonly vendors: readonly Vendor[];
}

export async function emitConfigsManifest(options: EmitConfigsManifestOptions): Promise<void> {
  const manifest = await buildConfigsManifest({
    outRoot: options.outRoot,
    vendors: options.vendors,
  });
  await mkdir(options.outRoot, { recursive: true });
  await writeFile(join(options.outRoot, "configs.json"), JSON.stringify(manifest, null, 2) + "\n");
}
