import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

import { throwInvariantViolations } from "../compile/discovery.js";
import { precomputeExistingRefs } from "../compile/frontmatter.js";
import { buildRegistry, type ReferenceOwner } from "../compile/validators.js";
import type { WarningSink } from "../compile/index.js";
import { pathExists } from "../fs.js";
import type { InstalledIndex } from "../installed.js";
import type { LocalIds } from "../layout/index.js";
import { substitute } from "../placeholders/index.js";
import { expandIncludes, formatIncludeError } from "../skill/index.js";
import type { Vendor } from "../vendor/schema.js";

const CONFIGS_OWNER: ReferenceOwner = { kind: "unrestricted", label: "<configs>" };

export interface CompileConfigsOptions {
  readonly srcRoot: string;
  readonly outRoot: string;
  readonly vendors: readonly Vendor[];
  readonly localIds?: LocalIds;
  readonly installedIndex?: InstalledIndex;
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

  for (const vendor of options.vendors) {
    const configsSrc = join(options.srcRoot, vendor.name, "configs");
    if (!(await pathExists(configsSrc))) continue;
    await compileVendor({
      configsSrc,
      configsOut: vendor.configsOutDir(options.outRoot),
      localIds,
      installedIndex,
      owner: CONFIGS_OWNER,
      ...(options.onWarnings ? { onWarnings: options.onWarnings } : {}),
    });
  }
}

interface CompileVendorOptions {
  readonly configsSrc: string;
  readonly configsOut: string;
  readonly localIds: LocalIds;
  readonly installedIndex: InstalledIndex;
  readonly owner: ReferenceOwner;
  readonly onWarnings?: WarningSink;
}

async function compileVendor(opts: CompileVendorOptions): Promise<void> {
  for await (const absPath of walk(opts.configsSrc)) {
    const rel = relative(opts.configsSrc, absPath);
    const outPath = join(opts.configsOut, rel);
    if (absPath.endsWith(".md")) {
      await emitSubstituted(absPath, outPath, opts.configsSrc, opts);
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
  const expanded = await expandIncludes(raw, srcPath, baseDir);
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
    opts.owner,
  );
  const result = substitute(body, registry);
  if (!result.ok) {
    throwInvariantViolations(srcPath, result.errors);
  }
  if (result.warnings.length > 0) opts.onWarnings?.(srcPath, result.warnings);
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, result.rendered);
}

async function* walk(dir: string): AsyncGenerator<string> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile()) yield full;
  }
}
