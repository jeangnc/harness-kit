import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import yaml from "js-yaml";

import type { Owner } from "../config/harness.js";
import { pathExists } from "../fs.js";
import { layoutAt, type Layout } from "../layout/index.js";
import { consumerWorkflow } from "../publish/workflow.js";

export interface InitOptions {
  readonly repoRoot: string;
  readonly marketplace: string;
  readonly owner: Owner;
  readonly vendors: readonly string[];
  readonly silent?: boolean;
}

const WORKFLOW_PATH = ".github/workflows/harness.yml";
const BUILD_IGNORE = ".harness/";

export async function initHarness(options: InitOptions): Promise<void> {
  const layout = layoutAt(options.repoRoot);
  const configPath = join(layout.repoRoot, "harness.yaml");
  const workflowPath = join(layout.repoRoot, WORKFLOW_PATH);
  for (const path of [configPath, workflowPath]) {
    if (await pathExists(path)) throw new Error(`refusing to overwrite existing ${path}`);
  }
  const doc = yaml.dump(
    { marketplace: options.marketplace, owner: options.owner, vendors: [...options.vendors] },
    { lineWidth: 120 },
  );
  await writeFile(configPath, doc);
  await scaffoldKeep(layout.pluginsDir);
  await scaffoldKeep(layout.configsDir);
  await mkdir(dirname(workflowPath), { recursive: true });
  await writeFile(workflowPath, consumerWorkflow());
  await ensureBuildIgnored(layout);
  if (!options.silent) {
    console.log(`scaffolded harness in ${layout.repoRoot}`);
  }
}

async function scaffoldKeep(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, ".gitkeep"), "");
}

async function ensureBuildIgnored(layout: Layout): Promise<void> {
  const path = join(layout.repoRoot, ".gitignore");
  const existing = (await pathExists(path)) ? await readFile(path, "utf8") : "";
  if (/^\/?\.harness\/?$/m.test(existing)) return;
  const trailing = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  await writeFile(path, `${existing}${trailing}${BUILD_IGNORE}\n`);
}
