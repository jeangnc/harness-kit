import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { throwInvariantViolations } from "./discovery.js";
import { unemittedSegment } from "./emit-paths.js";
import { SOURCE_PLUGIN_MANIFEST_TS } from "../layout/conventions.js";
import { pathExists } from "../fs.js";
import type { LayoutAdapter } from "../layout/index.js";

const ROOT_ASSIGNMENT = /\broot=.*CLAUDE_PLUGIN_ROOT/;
const ROOT_PATH_REF = /\$\{?root\}?\/([^"'\s)]+)/g;
const SKILL_LITERAL = /\b([a-z0-9-]+):[a-z0-9-]+\b/g;
const SKILL_REF = /\{\{skill:([a-z0-9-]+:[a-z0-9-]+)\}\}/g;
const LANG_SKILLS_REL = join("shared", "lang-skills.md");

interface HookScript {
  readonly fileName: string;
  readonly source: string;
}

interface UnemittedRead {
  readonly hookFile: string;
  readonly path: string;
  readonly segment: string;
}

interface UnmirroredSkill {
  readonly hookFile: string;
  readonly skillId: string;
}

export async function checkHookRootReads(adapter: LayoutAdapter): Promise<void> {
  for (const plugin of adapter.plugins) {
    const violations = collectUnemittedReads(await readHookScripts(plugin.hooksDir));
    if (violations.length > 0) {
      throwInvariantViolations(
        join(plugin.pluginDir, SOURCE_PLUGIN_MANIFEST_TS),
        violations.map(formatViolation),
      );
    }
  }
}

export async function checkHookSkillMirror(adapter: LayoutAdapter): Promise<void> {
  const pluginNames = new Set(adapter.plugins.map((plugin) => plugin.name));
  for (const plugin of adapter.plugins) {
    const mirrored = await readMirroredSkills(join(plugin.pluginDir, LANG_SKILLS_REL));
    if (mirrored === undefined) continue;
    const scripts = await readHookScripts(plugin.hooksDir);
    const violations = collectUnmirroredSkills(scripts, mirrored, pluginNames);
    if (violations.length > 0) {
      throwInvariantViolations(
        join(plugin.pluginDir, SOURCE_PLUGIN_MANIFEST_TS),
        violations.map(formatMirrorViolation),
      );
    }
  }
}

async function readHookScripts(hooksDir: string): Promise<readonly HookScript[]> {
  if (!(await pathExists(hooksDir))) return [];
  const entries = await readdir(hooksDir, { withFileTypes: true });
  const scripts: HookScript[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".sh")) continue;
    scripts.push({
      fileName: entry.name,
      source: await readFile(join(hooksDir, entry.name), "utf8"),
    });
  }
  return scripts;
}

async function readMirroredSkills(
  langSkillsPath: string,
): Promise<ReadonlySet<string> | undefined> {
  if (!(await pathExists(langSkillsPath))) return undefined;
  const source = await readFile(langSkillsPath, "utf8");
  const skills = new Set<string>();
  for (const [, skillId] of source.matchAll(SKILL_REF)) {
    if (skillId !== undefined) skills.add(skillId);
  }
  return skills;
}

function collectUnmirroredSkills(
  scripts: readonly HookScript[],
  mirrored: ReadonlySet<string>,
  pluginNames: ReadonlySet<string>,
): readonly UnmirroredSkill[] {
  const unmirrored: UnmirroredSkill[] = [];
  for (const { fileName, source } of scripts) {
    const seen = new Set<string>();
    for (const [skillId, pluginName] of source.matchAll(SKILL_LITERAL)) {
      if (mirrored.has(skillId) || seen.has(skillId)) continue;
      if (pluginName === undefined || !pluginNames.has(pluginName)) continue;
      seen.add(skillId);
      unmirrored.push({ hookFile: fileName, skillId });
    }
  }
  return unmirrored;
}

function formatMirrorViolation({ hookFile, skillId }: UnmirroredSkill): string {
  return `hook ${hookFile} names skill "${skillId}", but ${LANG_SKILLS_REL} does not resolve it — the hook's pattern map has drifted from the table`;
}

function collectUnemittedReads(scripts: readonly HookScript[]): readonly UnemittedRead[] {
  const reads: UnemittedRead[] = [];
  for (const { fileName, source } of scripts) {
    if (!ROOT_ASSIGNMENT.test(source)) continue;
    for (const match of source.matchAll(ROOT_PATH_REF)) {
      const path = match[1];
      if (!path || path.includes("$")) continue;
      const segment = unemittedSegment(path);
      if (segment === undefined) continue;
      reads.push({ hookFile: fileName, path, segment });
    }
  }
  return reads;
}

function formatViolation({ hookFile, path, segment }: UnemittedRead): string {
  return `hook ${hookFile} reads $root/${path}, but segment "${segment}" is dot-prefixed and the compiler will not emit it to dist`;
}
