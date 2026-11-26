import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { pathExists } from "../fs.js";
import type { InstalledIndex } from "../installed.js";
import type { LocalIds } from "../layout/index.js";
import { parsePlaceholders, substitute, type ValidatorRegistry } from "../placeholders/index.js";
import {
  expandIncludes,
  formatIncludeError,
  IDENTITY_VIEW,
  type Companion,
  type ExpandedBody,
  type SourceView,
} from "../skill/index.js";

import { throwInvariantViolations } from "./discovery.js";
import { buildRegistry } from "./validators.js";

export type WarningSink = (filePath: string, warnings: readonly string[]) => void;

export interface RenderContext {
  readonly localIds: LocalIds;
  readonly installedIndex: InstalledIndex;
  readonly repoRoot: string;
  readonly namedRoots: Readonly<Record<string, string>>;
  readonly view: SourceView;
  readonly onWarnings?: WarningSink;
}

export interface SourceFile {
  readonly logical: string;
  readonly physical: string;
}

export interface Rendered {
  readonly rendered: string;
  readonly warnings: readonly string[];
}

export async function renderMarkdownFile(
  file: SourceFile,
  outPath: string,
  ctx: RenderContext,
): Promise<void> {
  const expanded = await expandOrThrow(await readFile(file.physical, "utf8"), file, ctx);
  const registry = await placeholderRegistry({ body: expanded.body, file }, ctx);
  const result = substituteOrThrow(expanded.body, registry, file);
  reportWarnings(ctx, file, result.warnings);
  await writeOutput(outPath, result.rendered);
}

export async function expandOrThrow(
  body: string,
  file: SourceFile,
  ctx: RenderContext,
): Promise<ExpandedBody> {
  const expanded = await expandIncludes(body, file.physical, {
    repoRoot: ctx.repoRoot,
    named: ctx.namedRoots,
    view: ctx.view,
  });
  if (!expanded.ok) {
    throwInvariantViolations(file.physical, expanded.error.map(formatIncludeError));
  }
  return expanded.value;
}

export interface RegistrySubject {
  readonly body: string;
  readonly file: SourceFile;
  readonly companions?: readonly Companion[] | undefined;
}

export async function placeholderRegistry(
  subject: RegistrySubject,
  ctx: RenderContext,
): Promise<ValidatorRegistry> {
  const baseDir = dirname(subject.file.logical);
  return buildRegistry(
    subject.companions,
    ctx.localIds,
    ctx.installedIndex,
    await existingRefs(subject.body, baseDir, ctx.view),
    baseDir,
  );
}

export async function existingRefs(
  body: string,
  baseDir: string,
  view: SourceView = IDENTITY_VIEW,
): Promise<ReadonlySet<string>> {
  const values = parsePlaceholders(body)
    .filter((token) => token.prefix === "ref")
    .map((token) => token.value)
    .filter((value) => value !== null);
  const present = await Promise.all(
    values.map(async (value) => pathExists(view.physical(resolve(baseDir, value)))),
  );
  return new Set(values.filter((_, i) => present[i]));
}

export function substituteOrThrow(
  text: string,
  registry: ValidatorRegistry,
  file: SourceFile,
): Rendered {
  const result = substitute(text, registry);
  if (!result.ok) throwInvariantViolations(file.physical, result.errors);
  return { rendered: result.rendered, warnings: result.warnings };
}

export function reportWarnings(
  ctx: RenderContext,
  file: SourceFile,
  warnings: readonly string[],
): void {
  if (warnings.length > 0) ctx.onWarnings?.(file.physical, warnings);
}

export async function writeOutput(outPath: string, content: string): Promise<void> {
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, content);
}
