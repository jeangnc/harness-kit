import { readdir, stat } from "node:fs/promises";
import { relative } from "node:path";

import { pathExists } from "../fs.js";
import type { Vendor } from "../vendor/schema.js";

export type LinkKind = "file" | "dir";

export interface ConfigLink {
  readonly src: string;
  readonly vendors: readonly string[];
  readonly destRel: string;
  readonly kind: LinkKind;
}

export interface ConfigsManifest {
  readonly links: readonly ConfigLink[];
}

export interface ConfigsManifestOptions {
  readonly outRoot: string;
  readonly vendors: readonly Vendor[];
}

export async function buildConfigsManifest(
  options: ConfigsManifestOptions,
): Promise<ConfigsManifest> {
  const links: ConfigLink[] = [];
  for (const vendor of options.vendors) {
    const configsOut = vendor.configsOutDir(options.outRoot);
    if (!(await pathExists(configsOut))) continue;
    for (const entry of await listEntries(configsOut)) {
      const absPath = `${configsOut}/${entry}`;
      const kind = await kindOf(absPath);
      links.push({
        src: relative(options.outRoot, absPath),
        vendors: [vendor.name],
        destRel: entry,
        kind,
      });
    }
  }
  return { links };
}

async function listEntries(dir: string): Promise<readonly string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((e) => !e.name.startsWith("."))
    .map((e) => e.name)
    .toSorted((a, b) => a.localeCompare(b));
}

async function kindOf(p: string): Promise<LinkKind> {
  const s = await stat(p);
  return s.isDirectory() ? "dir" : "file";
}
