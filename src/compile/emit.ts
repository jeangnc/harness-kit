import { copyFile, mkdir } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";

import type { EffectiveTree } from "../overlay/index.js";
import {
  checkCompanionFiles,
  formatLoadSkillError,
  isReservedCompanionFilename,
  readSkillFile,
  SKILL_FILE,
} from "../skill/index.js";

import { throwInvariantViolations } from "./discovery.js";
import { checkCompanionsTokenParity, renderFrontmatter } from "./frontmatter.js";
import { unemittedSegment } from "./emit-paths.js";
import {
  expandOrThrow,
  placeholderRegistry,
  renderMarkdownFile,
  reportWarnings,
  substituteOrThrow,
  writeOutput,
  type RenderContext,
  type SourceFile,
} from "./render.js";

export type { LocalIds } from "../layout/index.js";

export type { WarningSink } from "./render.js";

export interface CompileTreeOptions {
  readonly tree: EffectiveTree;
  readonly outRoot: string;
  readonly skipRelPaths?: ReadonlySet<string>;
  readonly render: RenderContext;
}

interface TreeEntry {
  readonly rel: string;
  readonly file: SourceFile;
}

export async function compileTree(options: CompileTreeOptions): Promise<void> {
  const { tree, outRoot, render: ctx } = options;
  const skipRelPaths = options.skipRelPaths ?? new Set<string>();
  const entries = [...tree.files]
    .filter(([rel]) => unemittedSegment(rel) === undefined)
    .map(
      ([rel, physical]): TreeEntry => ({ rel, file: { logical: join(tree.root, rel), physical } }),
    );
  const skillFolders = collectSkillFolders(entries);
  const handled = new Set<string>();

  for (const { rel, file } of entries.filter((entry) => basename(entry.rel) === SKILL_FILE)) {
    const siblings = skillFolders.get(dirname(file.logical)) ?? [];
    const emitted = await emitSkill(file, join(outRoot, rel), siblings, ctx);
    for (const logical of emitted) handled.add(logical);
  }

  for (const { rel, file } of entries) {
    if (basename(rel) === SKILL_FILE) continue;
    if (handled.has(file.logical)) continue;
    if (skipRelPaths.has(rel)) continue;
    if (isUnderAnySkipDir(rel, skipRelPaths)) continue;

    const target = join(outRoot, rel);
    if (rel.endsWith(".md")) {
      await renderMarkdownFile(file, target, ctx);
    } else {
      await mkdir(dirname(target), { recursive: true });
      await copyFile(file.physical, target);
    }
  }
}

function isUnderAnySkipDir(rel: string, skipRelPaths: ReadonlySet<string>): boolean {
  for (const skip of skipRelPaths) {
    const skipDir = dirname(skip);
    if (skipDir === "." || skipDir === "") continue;
    if (rel === skipDir || rel.startsWith(`${skipDir}/`)) return true;
  }
  return false;
}

function collectSkillFolders(entries: readonly TreeEntry[]): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const { file } of entries) {
    const dir = dirname(file.logical);
    const name = basename(file.logical);
    if (name === SKILL_FILE) {
      result.set(dir, result.get(dir) ?? []);
    } else if (name.endsWith(".md") && !isReservedCompanionFilename(name)) {
      result.set(dir, [...(result.get(dir) ?? []), name]);
    }
  }
  return result;
}

async function emitSkill(
  file: SourceFile,
  outPath: string,
  siblings: readonly string[],
  ctx: RenderContext,
): Promise<ReadonlySet<string>> {
  const skillDir = dirname(file.logical);
  const loaded = await readSkillFile({ skillFilePath: file.physical, skillDir });
  if (!loaded.ok) {
    throwInvariantViolations(file.physical, formatLoadSkillError(loaded.error));
  }
  const { skill, body } = loaded.value;
  const expectedName = basename(skillDir);

  const expanded = await expandOrThrow(body, file, ctx);
  const includedLogical = [...expanded.resolvedIncludes].map((p) => ctx.view.logical(p));
  const includedSiblings = new Set(
    includedLogical.map((p) => relative(skillDir, p)).filter((rel) => !rel.startsWith("..")),
  );
  const filteredSiblings = siblings.filter((s) => !includedSiblings.has(s));

  const errors: string[] = [];
  if (skill.name !== expectedName) {
    errors.push(`name "${skill.name}" does not match folder "${expectedName}"`);
  }
  errors.push(...checkCompanionFiles(skill.companions, filteredSiblings));
  errors.push(...checkCompanionsTokenParity(expanded.body, skill.companions));
  if (errors.length > 0) {
    throwInvariantViolations(file.physical, errors);
  }

  const registry = await placeholderRegistry(
    { body: expanded.body, file, companions: skill.companions },
    ctx,
  );
  const result = substituteOrThrow(expanded.body, registry, file);
  const description = substituteOrThrow(skill.description, registry, file);
  reportWarnings(ctx, file, [...result.warnings, ...description.warnings]);
  await writeOutput(outPath, renderFrontmatter(skill, description.rendered) + result.rendered);

  const handled = new Set(includedLogical);
  for (const companion of skill.companions ?? []) {
    const logical = join(skillDir, companion.file);
    if (handled.has(logical)) continue;
    const companionFile = { logical, physical: ctx.view.physical(logical) };
    await renderMarkdownFile(companionFile, join(dirname(outPath), companion.file), ctx);
    handled.add(logical);
  }
  return handled;
}
