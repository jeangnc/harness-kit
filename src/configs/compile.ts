import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { throwInvariantViolations } from "../compile/discovery.js";
import { precomputeExistingRefs } from "../compile/frontmatter.js";
import { buildRegistry } from "../compile/validators.js";
import type { WarningSink } from "../compile/index.js";
import type { InstalledIndex } from "../installed.js";
import type { Layout, LocalIds } from "../layout/index.js";
import {
  effectiveTree,
  formatOverlayError,
  sourceView,
  type EffectiveTree,
} from "../overlay/index.js";
import { substitute } from "../placeholders/index.js";
import { expandIncludes, formatIncludeError, type SourceView } from "../skill/index.js";
import type { Vendor } from "../vendor/schema.js";

export interface CompileConfigsOptions {
  readonly layout: Layout;
  readonly vendors: readonly Vendor[];
  readonly localIds?: LocalIds;
  readonly installedIndex?: InstalledIndex;
  readonly namedRoots?: Readonly<Record<string, string>>;
  readonly onWarnings?: WarningSink;
}

const EMPTY_LOCAL_IDS: LocalIds = {
  skills: new Set(),
  commands: new Set(),
  agents: new Set(),
};

const EMPTY_INSTALLED_INDEX: InstalledIndex = {
  skills: new Map(),
  commands: new Map(),
  agents: new Map(),
};

export async function compileConfigs(options: CompileConfigsOptions): Promise<void> {
  const localIds = options.localIds ?? EMPTY_LOCAL_IDS;
  const installedIndex = options.installedIndex ?? EMPTY_INSTALLED_INDEX;
  const { layout } = options;
  const repoRoot = layout.repoRoot;
  const namedRoots = options.namedRoots ?? {};
  const registeredVendors = options.vendors.map((vendor) => vendor.name);

  for (const vendor of options.vendors) {
    const tree = await vendorTree(layout.configsDir, vendor.name, registeredVendors);
    if (tree.files.size === 0) continue;
    const rootTrees = await Promise.all(
      Object.values(namedRoots).map(async (root) =>
        vendorTree(root, vendor.name, registeredVendors),
      ),
    );
    await compileVendor({
      tree,
      view: sourceView([tree, ...rootTrees]),
      configsOut: vendor.configsOutDir(layout.buildDir),
      localIds,
      installedIndex,
      repoRoot,
      namedRoots,
      ...(options.onWarnings ? { onWarnings: options.onWarnings } : {}),
    });
  }
}

async function vendorTree(
  root: string,
  vendor: string,
  registeredVendors: readonly string[],
): Promise<EffectiveTree> {
  const tree = await effectiveTree({ root, vendor, registeredVendors });
  if (!tree.ok) throwInvariantViolations(root, tree.error.map(formatOverlayError));
  return tree.value;
}

interface CompileVendorOptions {
  readonly tree: EffectiveTree;
  readonly view: SourceView;
  readonly configsOut: string;
  readonly localIds: LocalIds;
  readonly installedIndex: InstalledIndex;
  readonly repoRoot: string;
  readonly namedRoots: Readonly<Record<string, string>>;
  readonly onWarnings?: WarningSink;
}

async function compileVendor(opts: CompileVendorOptions): Promise<void> {
  for (const [rel, absPath] of opts.tree.files) {
    if (rel.split("/").some((segment) => segment.startsWith("."))) continue;
    const outPath = join(opts.configsOut, rel);
    if (absPath.endsWith(".md")) {
      await emitSubstituted(absPath, outPath, dirname(absPath), opts);
    } else {
      await mkdir(dirname(outPath), { recursive: true });
      await copyFile(absPath, outPath);
    }
  }
}

async function emitSubstituted(
  srcPath: string,
  outPath: string,
  baseDir: string,
  opts: CompileVendorOptions,
): Promise<void> {
  const raw = await readFile(srcPath, "utf8");
  const expanded = await expandIncludes(raw, srcPath, {
    repoRoot: opts.repoRoot,
    named: opts.namedRoots,
    view: opts.view,
  });
  if (!expanded.ok) {
    throwInvariantViolations(srcPath, expanded.error.map(formatIncludeError));
  }
  const body = expanded.value.body;
  const existingRefs = await precomputeExistingRefs(body, baseDir);
  const registry = buildRegistry(
    undefined,
    opts.localIds,
    opts.installedIndex,
    existingRefs,
    baseDir,
  );
  const result = substitute(body, registry);
  if (!result.ok) {
    throwInvariantViolations(srcPath, result.errors);
  }
  if (result.warnings.length > 0) opts.onWarnings?.(srcPath, result.warnings);
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, result.rendered);
}
