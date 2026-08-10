import type { Stats } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { pathExists } from "../fs.js";
import { FQ_ID } from "../ids.js";
import { offsetToLineCol, parsePlaceholders } from "../placeholders/index.js";
import {
  checkCompanionFiles,
  findSkillFile,
  formatLoadSkillError,
  loadSkill,
} from "../skill/index.js";
import {
  collectLocalIds,
  formatLayoutError,
  loadLayout,
  type LayoutAdapter,
  type ResolvedPlugin,
} from "../layout/index.js";
import {
  defaultSources,
  discoverInstalled,
  indexInstalled,
  type PluginSource,
} from "../installed.js";

import {
  buildLeafIndex,
  detectBarewordBypasses,
  detectBypasses,
  detectRefBypasses,
  nonReferenceSpans,
  type BarewordBypass,
  type BypassHaystacks,
  type LeafIndex,
  type Span,
} from "./bypass.js";
import { unifiedKindConfigs, type KindConfig, type ReferencePrefix } from "./kinds.js";
import { closestMatch } from "./suggest.js";

export interface CheckOptions {
  readonly srcRoot: string;
  readonly docRoots?: readonly string[];
  readonly sources?: readonly PluginSource[];
}

export type ReferenceViolationKind = "malformed" | "unresolved" | "bareword" | "ref-bareword";

export interface ReferenceViolation {
  readonly kind: ReferenceViolationKind;
  readonly token: string;
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly message: string;
}

export interface SourceSummary {
  readonly source: string;
  readonly skillCount: number;
}

export interface BypassWarning {
  readonly kind: "bypass";
  readonly prefix: ReferencePrefix;
  readonly id: string;
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly message: string;
}

export interface UnresolvedExternalWarning {
  readonly kind: "unresolved-external";
  readonly token: string;
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly message: string;
}

export type Warning = BypassWarning | UnresolvedExternalWarning;

export interface CheckResult {
  readonly violations: readonly ReferenceViolation[];
  readonly warnings: readonly Warning[];
  readonly checkedFiles: number;
  readonly indexedSources: readonly SourceSummary[];
}

type BodyOrigin =
  | { readonly role: "skill"; readonly ownLeaf: string }
  | { readonly role: "command" }
  | { readonly role: "doc" };

type RefBoundary = string | null;

interface BodySource {
  readonly body: string;
  readonly bodyOffset: number;
  readonly fileText: string;
  readonly filePath: string;
  readonly refBoundary: RefBoundary;
  readonly origin: BodyOrigin;
  readonly frontmatter: boolean;
}

export async function check(options: CheckOptions): Promise<CheckResult> {
  const sources = options.sources ?? defaultSources();
  const artifacts = await discoverInstalled(sources);
  const installedIndex = indexInstalled(artifacts);
  const indexedSources = sources.map<SourceSummary>((s) => ({
    source: s.name,
    skillCount: artifacts.skills.filter((i) => i.source === s.name).length,
  }));

  const loaded = await loadLayout(options.srcRoot);
  if (!loaded.ok) throw new Error(`failed to load layout: ${formatLayoutError(loaded.error)}`);
  const localAdapter = loaded.value;
  const localIds = await collectLocalIds(localAdapter);
  const localPlugins = new Set(localAdapter.plugins.map((p) => p.name));

  const kinds = unifiedKindConfigs(localIds, installedIndex, localPlugins);
  const haystacks = bypassHaystacks(kinds);
  const leafIndex = buildLeafIndex(haystacks);

  const bodies = await collectBodySources(localAdapter, options.docRoots ?? []);
  const violations: ReferenceViolation[] = [];
  const warnings: Warning[] = [];
  for (const source of bodies) {
    const skip = nonReferenceSpans(source.body);
    const { violations: refViolations, warnings: refWarnings } = validateBody(source, kinds);
    violations.push(...refViolations);
    warnings.push(...refWarnings);
    for (const violation of findBarewordBypasses(source, leafIndex, skip)) {
      violations.push(violation);
    }
    for (const violation of await findRefBypasses(source, options.srcRoot, skip)) {
      violations.push(violation);
    }
    for (const violation of findEscapingRefs(source)) {
      violations.push(violation);
    }
    for (const warning of findBypasses(source, haystacks)) {
      warnings.push(warning);
    }
  }

  const checkedFiles = new Set(bodies.map((b) => b.filePath)).size;
  return { violations, warnings, checkedFiles, indexedSources };
}

function bypassHaystacks(kinds: ReadonlyMap<string, KindConfig>): BypassHaystacks {
  const haystackOf = (prefix: ReferencePrefix): ReadonlySet<string> =>
    kinds.get(prefix)?.haystack ?? new Set<string>();
  return {
    skill: haystackOf("skill"),
    command: haystackOf("command"),
    agent: haystackOf("agent"),
  };
}

function findBypasses(source: BodySource, haystacks: BypassHaystacks): readonly BypassWarning[] {
  return detectBypasses(source.body, haystacks).map((bypass) => {
    const { line, column } = offsetToLineCol(source.fileText, source.bodyOffset + bypass.offset);
    return {
      kind: "bypass",
      prefix: bypass.prefix,
      id: bypass.id,
      file: source.filePath,
      line,
      column,
      message: `\`${bypass.id}\` ${bypass.prefix} referenced directly — use \`{{${bypass.prefix}:${bypass.id}}}\` so harness-kit can track it`,
    };
  });
}

function findBarewordBypasses(
  source: BodySource,
  index: LeafIndex,
  skip: readonly Span[],
): readonly ReferenceViolation[] {
  const ownLeaf = source.origin.role === "skill" ? source.origin.ownLeaf : null;
  return detectBarewordBypasses(source.body, index, { ownLeaf }, skip).map((bypass) => {
    const { line, column } = offsetToLineCol(source.fileText, source.bodyOffset + bypass.offset);
    return {
      kind: "bareword",
      token: bypass.leaf,
      file: source.filePath,
      line,
      column,
      message: barewordMessage(bypass),
    };
  });
}

function barewordMessage(bypass: BarewordBypass): string {
  const nouns = [...new Set(bypass.candidates.map((c) => c.prefix))].join(" and ");
  const forms = bypass.candidates.map((c) => `{{${c.prefix}:${c.handle}}}`).join(" or ");
  return `\`${bypass.leaf}\` names a known ${nouns} but isn't a tracked reference — use ${forms}`;
}

async function findRefBypasses(
  source: BodySource,
  rootDir: string,
  skip: readonly Span[],
): Promise<readonly ReferenceViolation[]> {
  const sourceDir = dirname(source.filePath);
  const scope = source.frontmatter ? "frontmatter" : "prose";
  const bypasses = await detectRefBypasses(source.body, sourceDir, rootDir, skip, scope);
  return bypasses.map((bypass) => {
    const { line, column } = offsetToLineCol(source.fileText, source.bodyOffset + bypass.offset);
    return {
      kind: "ref-bareword",
      token: bypass.path,
      file: source.filePath,
      line,
      column,
      message: `\`${bypass.path}\` is a companion file referenced directly — use \`{{ref:${bypass.suggestion}}}\` so harness-kit can track it`,
    };
  });
}

function findEscapingRefs(source: BodySource): readonly ReferenceViolation[] {
  const boundary = source.refBoundary;
  if (boundary === null) return [];
  const violations: ReferenceViolation[] = [];
  const sourceDir = dirname(source.filePath);
  for (const token of parsePlaceholders(source.body)) {
    if (token.prefix !== "ref" || token.value === null) continue;
    if (!escapesPlugin(resolve(sourceDir, token.value), boundary)) continue;
    const { line, column } = offsetToLineCol(source.fileText, source.bodyOffset + token.start);
    violations.push({
      kind: "unresolved",
      token: token.value,
      file: source.filePath,
      line,
      column,
      message: `\`${token.value}\` ref resolves outside its plugin — \`{{ref:}}\` renders a relative runtime path and is same-plugin only; the installed layout nests each plugin under a version directory that \`src/\` does not have, so this resolves in \`src/\` and breaks once installed`,
    });
  }
  return violations;
}

function escapesPlugin(target: string, boundary: string): boolean {
  const rel = relative(boundary, target);
  return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

async function collectBodySources(
  adapter: LayoutAdapter,
  docRoots: readonly string[],
): Promise<readonly BodySource[]> {
  const seen = new Set<string>();
  const out: BodySource[] = [];
  const push = async (file: CollectedBody): Promise<void> => {
    const key = `${file.filePath}:${file.bodyOffset}:${file.body.length}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      body: file.body,
      bodyOffset: file.bodyOffset,
      fileText: await readFile(file.filePath, "utf8"),
      filePath: file.filePath,
      refBoundary: file.refBoundary,
      origin: file.origin,
      frontmatter: file.frontmatter ?? false,
    });
  };

  for (const plugin of adapter.plugins) {
    for (const file of await collectPluginBodies(plugin)) {
      await push(file);
    }
  }

  for (const file of await collectDocBodies(docRoots, adapter)) {
    await push(file);
  }

  return out;
}

async function collectDocBodies(
  docRoots: readonly string[],
  adapter: LayoutAdapter,
): Promise<readonly CollectedBody[]> {
  const ownedByPlugin = pluginOwnershipTest(adapter);
  const out: CollectedBody[] = [];
  for (const root of docRoots) {
    for await (const filePath of markdownUnder(resolve(root))) {
      if (ownedByPlugin(filePath)) continue;
      out.push({
        filePath,
        body: await readFile(filePath, "utf8"),
        bodyOffset: 0,
        refBoundary: null,
        origin: { role: "doc" },
      });
    }
  }
  return out;
}

function pluginOwnershipTest(adapter: LayoutAdapter): (filePath: string) => boolean {
  const pluginDirs = adapter.plugins.map((plugin) => `${resolve(plugin.pluginDir)}${sep}`);
  return (filePath) => pluginDirs.some((dir) => filePath.startsWith(dir));
}

async function* markdownUnder(target: string): AsyncGenerator<string> {
  const stats = await statOrNull(target);
  if (stats === null) return;
  if (stats.isDirectory()) yield* walkMarkdown(target);
  else if (target.endsWith(".md")) yield target;
}

async function statOrNull(target: string): Promise<Stats | null> {
  try {
    return await stat(target);
  } catch {
    return null;
  }
}

interface CollectedBody {
  readonly filePath: string;
  readonly body: string;
  readonly bodyOffset: number;
  readonly refBoundary: RefBoundary;
  readonly origin: BodyOrigin;
  readonly frontmatter?: boolean;
}

async function collectPluginBodies(plugin: ResolvedPlugin): Promise<readonly CollectedBody[]> {
  const out: CollectedBody[] = [];
  if (await pathExists(plugin.skillsDir)) {
    for (const entry of await readdir(plugin.skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const skillDir = join(plugin.skillsDir, entry.name);
      const found = await findSkillFile(skillDir);
      if (!found.ok || !found.value) continue;
      out.push(...(await loadSkillBodies(skillDir, plugin.pluginDir)));
    }
  }
  for await (const filePath of walkMarkdown(plugin.pluginDir)) {
    if (filePath.startsWith(plugin.skillsDir)) continue;
    const body = await readFile(filePath, "utf8");
    const role = filePath.startsWith(plugin.commandsDir) ? "command" : "doc";
    out.push({
      filePath,
      body,
      bodyOffset: 0,
      refBoundary: plugin.pluginDir,
      origin: { role },
    });
  }
  return out;
}

async function* walkMarkdown(dir: string): AsyncGenerator<string> {
  if (!(await pathExists(dir))) return;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walkMarkdown(full);
    else if (entry.isFile() && entry.name.endsWith(".md")) yield full;
  }
}

async function loadSkillBodies(
  skillDir: string,
  refBoundary: string,
): Promise<readonly CollectedBody[]> {
  const loaded = await loadSkill(skillDir);
  if (!loaded.ok) {
    throw new Error(
      `failed to load skill at ${skillDir}:\n  - ${formatLoadSkillError(loaded.error).join("\n  - ")}`,
    );
  }
  const { skill, body, bodyFilePath, bodyOffset, skillDir: dir } = loaded.value;
  const origin = { role: "skill", ownLeaf: basename(dir) } as const;
  const primary: CollectedBody = { filePath: bodyFilePath, body, bodyOffset, refBoundary, origin };
  const declared = skill.companions ?? [];
  const present = await Promise.all(declared.map(async (c) => pathExists(join(dir, c.file))));
  const missing = checkCompanionFiles(
    declared,
    declared.filter((_, i) => present[i]).map((c) => c.file),
  );
  if (missing.length > 0) {
    throw new Error(`failed to load skill at ${dir}:\n  - ${missing.join("\n  - ")}`);
  }
  const companions = await Promise.all(
    declared.map(async (companion): Promise<CollectedBody> => {
      const filePath = join(dir, companion.file);
      return {
        filePath,
        body: await readFile(filePath, "utf8"),
        bodyOffset: 0,
        refBoundary,
        origin,
      };
    }),
  );
  if (loaded.value.source !== "md") return [primary, ...companions];
  const skillText = await readFile(loaded.value.skillFilePath, "utf8");
  const frontmatter = frontmatterBodies(
    skillText,
    loaded.value.skillFilePath,
    [skill.description, ...declared.map((c) => c.summary)],
    origin,
    refBoundary,
  );
  return [primary, ...companions, ...frontmatter];
}

function frontmatterBodies(
  skillText: string,
  skillFilePath: string,
  values: readonly string[],
  origin: BodyOrigin,
  refBoundary: string,
): readonly CollectedBody[] {
  const bodies: CollectedBody[] = [];
  let cursor = 0;
  for (const value of values) {
    const at = skillText.indexOf(value, cursor);
    if (at === -1) continue;
    cursor = at + value.length;
    bodies.push({
      filePath: skillFilePath,
      body: value,
      bodyOffset: at,
      refBoundary,
      origin,
      frontmatter: true,
    });
  }
  return bodies;
}

interface ValidatedBody {
  readonly violations: readonly ReferenceViolation[];
  readonly warnings: readonly UnresolvedExternalWarning[];
}

function validateBody(source: BodySource, kinds: ReadonlyMap<string, KindConfig>): ValidatedBody {
  const violations: ReferenceViolation[] = [];
  const warnings: UnresolvedExternalWarning[] = [];
  for (const token of parsePlaceholders(source.body)) {
    const kind = kinds.get(token.prefix);
    if (!kind) continue;
    const { line, column } = offsetToLineCol(source.fileText, source.bodyOffset + token.start);
    const at = { token: token.raw, file: source.filePath, line, column };

    if (token.value === null || !FQ_ID.test(token.value)) {
      violations.push({ ...at, kind: "malformed", message: kind.malformedHint });
      continue;
    }

    if (kind.haystack.has(token.value)) continue;

    const suggestion = closestMatch(token.value, [...kind.haystack]);
    const plugin = token.value.slice(0, token.value.indexOf(":"));
    if (kind.localPlugins.has(plugin)) {
      violations.push({
        ...at,
        kind: "unresolved",
        message: withSuggestion(token.value, kind.noun, kind.internalMissingHint, suggestion),
      });
    } else {
      warnings.push({
        ...at,
        kind: "unresolved-external",
        message: withSuggestion(token.value, kind.noun, kind.externalMissingHint, suggestion),
      });
    }
  }
  return { violations, warnings };
}

function withSuggestion(id: string, noun: string, hint: string, suggestion: string | null): string {
  const base = `\`${id}\` ${noun} ${hint}`;
  return suggestion ? `${base} (did you mean \`${suggestion}\`?)` : base;
}
