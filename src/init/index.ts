import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import yaml from "js-yaml";

import { pathExists } from "../fs.js";

export interface InitOptions {
  readonly repoRoot: string;
  readonly marketplace: string;
  readonly vendors: readonly string[];
  readonly silent?: boolean;
}

export async function initHarness(options: InitOptions): Promise<void> {
  const configPath = join(options.repoRoot, "harness.yaml");
  if (await pathExists(configPath)) {
    throw new Error(`harness.yaml already exists at ${configPath}`);
  }
  const doc = yaml.dump(
    { marketplace: options.marketplace, vendors: [...options.vendors] },
    { lineWidth: 120 },
  );
  await writeFile(configPath, doc);
  for (const vendor of options.vendors) {
    await scaffoldKeep(join(options.repoRoot, "src", vendor, "configs"));
  }
  await scaffoldKeep(join(options.repoRoot, "src/plugins"));
  await ensureGitignore(options.repoRoot);
  if (!options.silent) {
    console.log(`scaffolded harness in ${options.repoRoot}`);
  }
}

async function scaffoldKeep(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, ".gitkeep"), "");
}

async function ensureGitignore(repoRoot: string): Promise<void> {
  const path = join(repoRoot, ".gitignore");
  const existing = (await pathExists(path)) ? await readFile(path, "utf8") : "";
  const hasDist = /^dist\/?$/m.test(existing);
  if (hasDist) return;
  const trailing = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  await writeFile(path, `${existing}${trailing}dist/\n`);
}
