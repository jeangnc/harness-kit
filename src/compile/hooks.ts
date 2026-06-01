import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { throwInvariantViolations } from "./discovery.js";
import { unemittedSegment } from "./emit-paths.js";
import { SOURCE_PLUGIN_MANIFEST_TS } from "../layout/conventions.js";
import { pathExists } from "../fs.js";
import type { LayoutAdapter } from "../layout/index.js";

const ROOT_ASSIGNMENT = /\broot=.*CLAUDE_PLUGIN_ROOT/;
const ROOT_PATH_REF = /\$\{?root\}?\/([^"'\s)]+)/g;

interface UnemittedRead {
  readonly hookFile: string;
  readonly path: string;
  readonly segment: string;
}

export async function checkHookRootReads(adapter: LayoutAdapter): Promise<void> {
  for (const plugin of adapter.plugins) {
    const violations = await collectUnemittedReads(plugin.hooksDir);
    if (violations.length > 0) {
      throwInvariantViolations(
        join(plugin.pluginDir, SOURCE_PLUGIN_MANIFEST_TS),
        violations.map(formatViolation),
      );
    }
  }
}

async function collectUnemittedReads(hooksDir: string): Promise<readonly UnemittedRead[]> {
  if (!(await pathExists(hooksDir))) return [];
  const entries = await readdir(hooksDir, { withFileTypes: true });
  const reads: UnemittedRead[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".sh")) continue;
    const source = await readFile(join(hooksDir, entry.name), "utf8");
    if (!ROOT_ASSIGNMENT.test(source)) continue;
    for (const match of source.matchAll(ROOT_PATH_REF)) {
      const path = match[1];
      if (!path || path.includes("$")) continue;
      const segment = unemittedSegment(path);
      if (segment === undefined) continue;
      reads.push({ hookFile: entry.name, path, segment });
    }
  }
  return reads;
}

function formatViolation({ hookFile, path, segment }: UnemittedRead): string {
  return `hook ${hookFile} reads $root/${path}, but segment "${segment}" is dot-prefixed and the compiler will not emit it to dist`;
}
