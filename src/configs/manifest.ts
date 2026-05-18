import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import { pathExists } from "../fs.js";

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

export interface BuildConfigsManifestOptions {
  readonly srcRoot: string;
  readonly vendors: readonly string[];
}

const COMMON_SCOPE = "common";

export async function buildConfigsManifest(
  options: BuildConfigsManifestOptions,
): Promise<ConfigsManifest> {
  const configsRoot = join(options.srcRoot, "configs");
  if (!(await pathExists(configsRoot))) return { links: [] };

  const links: ConfigLink[] = [];
  const commonDir = join(configsRoot, COMMON_SCOPE);
  if (await pathExists(commonDir)) {
    for (const entry of await listEntries(commonDir)) {
      const kind = await kindOf(join(commonDir, entry));
      links.push({
        src: `configs/${COMMON_SCOPE}/${entry}`,
        vendors: options.vendors,
        destRel: entry,
        kind,
      });
    }
  }

  for (const vendor of options.vendors) {
    const vendorDir = join(configsRoot, vendor);
    if (!(await pathExists(vendorDir))) continue;
    for (const entry of await listEntries(vendorDir)) {
      const kind = await kindOf(join(vendorDir, entry));
      links.push({
        src: `configs/${vendor}/${entry}`,
        vendors: [vendor],
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
