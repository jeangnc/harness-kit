import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import { renderMarkdownFile, type WarningSink } from "../compile/render.js";
import { vendorTree, vendorWorkspace, workspaceView } from "../compile/trees.js";
import type { InstalledIndex } from "../installed.js";
import { vendorBuild, type Catalog, type Layout } from "../layout/index.js";
import { overlayVendorNames } from "../vendor/builtins.js";
import type { Vendor } from "../vendor/schema.js";

export interface CompileConfigsOptions {
  readonly layout: Layout;
  readonly vendors: readonly Vendor[];
  readonly catalog?: Catalog;
  readonly installedIndex?: InstalledIndex;
  readonly namedRoots?: Readonly<Record<string, string>>;
  readonly onWarnings?: WarningSink;
}

const EMPTY_INSTALLED_INDEX: InstalledIndex = {
  skills: new Map(),
  commands: new Map(),
  agents: new Map(),
};

export async function compileConfigs(options: CompileConfigsOptions): Promise<void> {
  const { layout } = options;
  const namedRoots = options.namedRoots ?? {};
  const plugins = options.catalog?.plugins ?? [];
  const render = {
    installedIndex: options.installedIndex ?? EMPTY_INSTALLED_INDEX,
    repoRoot: layout.repoRoot,
    namedRoots,
    ...(options.onWarnings ? { onWarnings: options.onWarnings } : {}),
  };
  const registeredVendors = overlayVendorNames(options.vendors);

  for (const vendor of options.vendors) {
    const scope = { vendor: vendor.name, registeredVendors };
    const tree = await vendorTree(layout.configsDir, scope);
    if (tree.files.size === 0) continue;
    const workspace = await vendorWorkspace({ plugins, namedRoots }, scope);
    const ctx = {
      ...render,
      localIds: workspace.localIds,
      view: workspaceView(workspace, tree),
    };
    const configsOut = vendorBuild(layout.buildDir, vendor.name).configsDir;
    for (const [rel, physical] of tree.files) {
      if (rel.split("/").some((segment) => segment.startsWith("."))) continue;
      const outPath = join(configsOut, rel);
      if (rel.endsWith(".md")) {
        await renderMarkdownFile({ logical: join(tree.root, rel), physical }, outPath, ctx);
      } else {
        await mkdir(dirname(outPath), { recursive: true });
        await copyFile(physical, outPath);
      }
    }
  }
}
