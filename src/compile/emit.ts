import { mkdir, readdir, copyFile, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";

import {
  checkCompanionFiles,
  expandIncludes,
  formatIncludeError,
  formatLoadSkillError,
  isReservedCompanionFilename,
  loadSkill,
} from "../skill/index.js";
import { substitute } from "../placeholders/index.js";

import { throwInvariantViolations } from "./discovery.js";
import {
  checkCompanionsTokenParity,
  precomputeExistingRefs,
  renderFrontmatter,
} from "./frontmatter.js";
import { buildRegistry, type OwningPlugin } from "./validators.js";
import type { LocalIds } from "../layout/index.js";

const SKILL_SOURCE_FILENAMES: ReadonlySet<string> = new Set(["SKILL.ts", "SKILL.md"]);

export type { LocalIds } from "../layout/index.js";
export type { OwningPlugin } from "./validators.js";

export type BodyInvariant = (body: string) => string[];

export interface CompileTreeOptions {
  readonly srcRoot: string;
  readonly outRoot: string;
  readonly localIds: LocalIds;
  readonly bodyInvariants: readonly BodyInvariant[];
  readonly contextFiles?: ReadonlySet<string>;
  readonly owner: OwningPlugin;
  readonly skipRelPaths?: ReadonlySet<string>;
}

export async function compileTree(options: CompileTreeOptions): Promise<void> {
  const { srcRoot, outRoot, localIds, bodyInvariants, owner } = options;
  const contextFiles = options.contextFiles ?? new Set<string>();
  const skipRelPaths = options.skipRelPaths ?? new Set<string>();
  const skillFolders = await collectSkillFolders(srcRoot);
  const handledAbsPaths = new Set<string>();

  for await (const absPath of walk(srcRoot)) {
    if (!SKILL_SOURCE_FILENAMES.has(basename(absPath))) continue;
    const target = join(outRoot, relative(srcRoot, absPath));
    const companions = skillFolders.get(dirname(absPath)) ?? [];
    const result = await emitSkill(
      absPath,
      join(dirname(target), "SKILL.md"),
      companions,
      localIds,
      bodyInvariants,
      owner,
    );
    for (const p of result.resolvedIncludes) handledAbsPaths.add(p);
    for (const p of result.emittedCompanions) handledAbsPaths.add(p);
  }

  for (const absPath of contextFiles) {
    const target = join(outRoot, relative(srcRoot, absPath));
    await emitContextFile(absPath, target, localIds, owner);
    handledAbsPaths.add(absPath);
  }

  for await (const absPath of walk(srcRoot)) {
    const file = basename(absPath);
    const rel = relative(srcRoot, absPath);
    if (SKILL_SOURCE_FILENAMES.has(file)) continue;
    if (absPath.endsWith(".ts")) continue;
    if (file === "body.md") continue;
    if (handledAbsPaths.has(absPath)) continue;
    if (skipRelPaths.has(rel)) continue;
    if (isUnderAnySkipDir(rel, skipRelPaths)) continue;

    const target = join(outRoot, relative(srcRoot, absPath));
    await mkdir(dirname(target), { recursive: true });
    await copyFile(absPath, target);
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

async function emitContextFile(
  srcPath: string,
  outPath: string,
  localIds: LocalIds,
  owner: OwningPlugin,
): Promise<void> {
  await emitSubstitutedFile(srcPath, outPath, dirname(srcPath), localIds, owner);
}

async function collectSkillFolders(srcRoot: string): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  for await (const absPath of walk(srcRoot)) {
    const dir = dirname(absPath);
    const file = basename(absPath);
    if (SKILL_SOURCE_FILENAMES.has(file)) {
      result.set(dir, result.get(dir) ?? []);
    } else if (file.endsWith(".md") && !isReservedCompanionFilename(file)) {
      const list = result.get(dir) ?? [];
      list.push(file);
      result.set(dir, list);
    }
  }
  return result;
}

interface EmitResult {
  readonly resolvedIncludes: ReadonlySet<string>;
  readonly emittedCompanions: ReadonlySet<string>;
}

async function emitSkill(
  srcPath: string,
  outPath: string,
  siblings: readonly string[],
  localIds: LocalIds,
  bodyInvariants: readonly BodyInvariant[],
  owner: OwningPlugin,
): Promise<EmitResult> {
  const skillDir = dirname(srcPath);
  const loaded = await loadSkill(skillDir);
  if (!loaded.ok) {
    throwInvariantViolations(srcPath, formatLoadSkillError(loaded.error));
  }
  const { skill, body } = loaded.value;
  const expectedName = basename(skillDir);

  const expanded = await expandIncludes(body, loaded.value.skillFilePath, skillDir);
  if (!expanded.ok) {
    throwInvariantViolations(srcPath, expanded.error.map(formatIncludeError));
  }
  const expandedBody = expanded.value.body;
  const includedFilenames = new Set(
    [...expanded.value.resolvedIncludes].map((p) => relative(skillDir, p)),
  );
  const filteredSiblings = siblings.filter((s) => !includedFilenames.has(s));

  const errors: string[] = [];
  if (skill.name !== expectedName) {
    errors.push(`name "${skill.name}" does not match folder "${expectedName}"`);
  }
  for (const check of bodyInvariants) {
    errors.push(...check(expandedBody));
  }
  errors.push(...checkCompanionFiles(skill.companions, filteredSiblings));
  errors.push(...checkCompanionsTokenParity(expandedBody, skill.companions));

  if (errors.length > 0) {
    throwInvariantViolations(srcPath, errors);
  }

  const existingRefs = await precomputeExistingRefs(expandedBody, skillDir);
  const registry = buildRegistry(skill.companions, localIds, existingRefs, skillDir, owner);
  const result = substitute(expandedBody, registry);
  if (!result.ok) {
    throwInvariantViolations(srcPath, result.errors);
  }

  const descriptionResult = substitute(skill.description, registry);
  if (!descriptionResult.ok) {
    throwInvariantViolations(srcPath, descriptionResult.errors);
  }

  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, renderFrontmatter(skill, descriptionResult.rendered) + result.rendered);

  const emittedCompanions = new Set<string>();
  for (const companion of skill.companions ?? []) {
    const companionSrc = join(skillDir, companion.file);
    if (expanded.value.resolvedIncludes.has(companionSrc)) continue;
    const companionOut = join(dirname(outPath), companion.file);
    await emitSubstitutedFile(companionSrc, companionOut, skillDir, localIds, owner);
    emittedCompanions.add(companionSrc);
  }

  return { resolvedIncludes: expanded.value.resolvedIncludes, emittedCompanions };
}

async function emitSubstitutedFile(
  srcPath: string,
  outPath: string,
  baseDir: string,
  localIds: LocalIds,
  owner: OwningPlugin,
): Promise<void> {
  const raw = await readFile(srcPath, "utf8");
  const expanded = await expandIncludes(raw, srcPath, baseDir);
  if (!expanded.ok) {
    throwInvariantViolations(srcPath, expanded.error.map(formatIncludeError));
  }
  const body = expanded.value.body;
  const existingRefs = await precomputeExistingRefs(body, baseDir);
  const registry = buildRegistry(undefined, localIds, existingRefs, baseDir, owner);
  const result = substitute(body, registry);
  if (!result.ok) {
    throwInvariantViolations(srcPath, result.errors);
  }
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, result.rendered);
}

async function* walk(dir: string): AsyncGenerator<string> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile()) yield full;
  }
}
