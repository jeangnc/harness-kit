import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { buildConfigsManifest } from "./manifest.js";

export interface EmitConfigsManifestOptions {
  readonly srcRoot: string;
  readonly outRoot: string;
  readonly vendors: readonly string[];
}

export async function emitConfigsManifest(options: EmitConfigsManifestOptions): Promise<void> {
  const manifest = await buildConfigsManifest({
    srcRoot: options.srcRoot,
    vendors: options.vendors,
  });
  await mkdir(options.outRoot, { recursive: true });
  await writeFile(join(options.outRoot, "configs.json"), JSON.stringify(manifest, null, 2) + "\n");
}
