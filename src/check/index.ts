import type { Stats } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { pathExists } from "../fs.js";
import { FQ_ID } from "../ids.js";
import { offsetToLineCol, parsePlaceholders } from "../placeholders/index.js";
import {
  checkCompanionFiles,
  formatLoadSkillError,
  readSkillFile,
  type SourceView,
} from "../skill/index.js";
import { vendorWorkspace, type VendorWorkspace } from "../compile/trees.js";
import type { SourceFile } from "../compile/render.js";
import { resolveRootsForRepo } from "../config/harness.js";
import { sourceView, type EffectiveTree } from "../overlay/index.js";
import { overlayVendorNames } from "../vendor/builtins.js";
import { resolveVendorsForRepo } from "../vendor/registry.js";
import {
  layoutAt,
  loadCatalogOrThrow,
  type Catalog,
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
  readonly repoRoot: string;
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
  readonly logicalPath: string;
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

  const layout = layoutAt(options.repoRoot);
  const catalog = await loadCatalogOrThrow(layout);
  const vendors = await resolveVendorsForRepo(layout.repoRoot);
  const namedRoots = await resolveRootsForRepo(layout.repoRoot);
  const registeredVendors = overlayVendorNames(vendors);
  const localPlugins = new Set(catalog.plugins.map((p) => p.name));

  const scans = await Promise.all(
    vendors.map(async (vendor) => {
      const workspace = await vendorWorkspace(
        { plugins: catalog.plugins, namedRoots },
        { vendor: vendor.name, registeredVendors },
      );
      const kinds = unifiedKindConfigs(workspace.localIds, installedIndex, localPlugins);
      const bodies = await collectBodySources({
        catalog,
        workspace,
        docRoots: options.docRoots ?? [],
      });
      return { bodies, ...(await checkBodies(bodies, kinds, layout.repoRoot)) };
    }),
  );

  return {
    violations: uniqueFindings(scans.flatMap((scan) => scan.violations)),
    warnings: uniqueFindings(scans.flatMap((scan) => scan.warnings)),
    checkedFiles: new Set(scans.flatMap((scan) => scan.bodies.map((b) => b.filePath))).size,
    indexedSources,
  };
}

interface BodyFindings {
  readonly violations: readonly ReferenceViolation[];
  readonly warnings: readonly Warning[];
}

async function checkBodies(
  bodies: readonly BodySource[],
  kinds: ReadonlyMap<string, KindConfig>,
  repoRoot: string,
): Promise<BodyFindings> {
  const haystacks = bypassHaystacks(kinds);
  const leafIndex = buildLeafIndex(haystacks);
  const violations: ReferenceViolation[] = [];
  const warnings: Warning[] = [];
  for (const source of bodies) {
    const skip = nonReferenceSpans(source.body);
    const { violations: refViolations, warnings: refWarnings } = validateBody(source, kinds);
    violations.push(...refViolations);
    warnings.push(...refWarnings);
    violations.push(...findBarewordBypasses(source, leafIndex, skip));
    violations.push(...(await findRefBypasses(source, source.refBoundary ?? repoRoot, skip)));
    violations.push(...findEscapingRefs(source));
    warnings.push(...findBypasses(source, haystacks));
  }
  return { violations, warnings };
}

interface Finding {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly message: string;
}

function uniqueFindings<T extends Finding>(findings: readonly T[]): readonly T[] {
  const byKey = new Map(findings.map((f) => [`${f.file}:${f.line}:${f.column}:${f.message}`, f]));
  return [...byKey.values()];
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
  const sourceDir = dirname(source.logicalPath);
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
  const sourceDir = dirname(source.logicalPath);
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
      message: `\`${token.value}\` ref resolves outside its plugin — \`{{ref:}}\` renders a relative runtime path and is same-plugin only; the installed layout nests each plugin under a version directory that the source tree does not have, so this resolves in the source tree and breaks once installed`,
    });
  }
  return violations;
}

function escapesPlugin(target: string, boundary: string): boolean {
  const rel = relative(boundary, target);
  return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

interface BodyScope {
  readonly catalog: Catalog;
  readonly workspace: VendorWorkspace;
  readonly docRoots: readonly string[];
}

async function collectBodySources(scope: BodyScope): Promise<readonly BodySource[]> {
  const collected: CollectedBody[] = [];
  for (const plugin of scope.catalog.plugins) {
    const tree = scope.workspace.pluginTrees.get(plugin.name);
    if (tree === undefined) continue;
    collected.push(...(await collectPluginBodies(plugin, tree)));
  }
  collected.push(...(await collectDocBodies(scope.docRoots, scope.catalog)));
  return Promise.all(
    collected.map(
      async (file): Promise<BodySource> => ({
        body: file.body,
        bodyOffset: file.bodyOffset,
        fileText: await readFile(file.filePath, "utf8"),
        filePath: file.filePath,
        logicalPath: file.logicalPath,
        refBoundary: file.refBoundary,
        origin: file.origin,
        frontmatter: file.frontmatter ?? false,
      }),
    ),
  );
}

async function collectDocBodies(
  docRoots: readonly string[],
  catalog: Catalog,
): Promise<readonly CollectedBody[]> {
  const ownedByPlugin = pluginOwnershipTest(catalog);
  const out: CollectedBody[] = [];
  for (const root of docRoots) {
    for await (const filePath of markdownUnder(resolve(root))) {
      if (ownedByPlugin(filePath)) continue;
      out.push({
        filePath,
        logicalPath: filePath,
        body: await readFile(filePath, "utf8"),
        bodyOffset: 0,
        refBoundary: null,
        origin: { role: "doc" },
      });
    }
  }
  return out;
}

function pluginOwnershipTest(catalog: Catalog): (filePath: string) => boolean {
  const pluginDirs = catalog.plugins.map((plugin) => `${resolve(plugin.pluginDir)}${sep}`);
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
  readonly logicalPath: string;
  readonly body: string;
  readonly bodyOffset: number;
  readonly refBoundary: RefBoundary;
  readonly origin: BodyOrigin;
  readonly frontmatter?: boolean;
}

const SKILL_ENTRY = /^skills\/[^/]+\/SKILL\.md$/;

async function collectPluginBodies(
  plugin: ResolvedPlugin,
  tree: EffectiveTree,
): Promise<readonly CollectedBody[]> {
  const view = sourceView([tree]);
  const markdown = [...tree.files].filter(([rel]) => rel.endsWith(".md"));
  const skills = await Promise.all(
    markdown
      .filter(([rel]) => SKILL_ENTRY.test(rel))
      .map(async ([rel, physical]) =>
        loadSkillBodies({ logical: join(plugin.pluginDir, rel), physical }, plugin.pluginDir, view),
      ),
  );
  const others = await Promise.all(
    markdown
      .filter(([rel]) => !rel.startsWith("skills/"))
      .map(
        async ([rel, physical]): Promise<CollectedBody> => ({
          filePath: physical,
          logicalPath: join(plugin.pluginDir, rel),
          body: await readFile(physical, "utf8"),
          bodyOffset: 0,
          refBoundary: plugin.pluginDir,
          origin: { role: rel.startsWith("commands/") ? "command" : "doc" },
        }),
      ),
  );
  return [...skills.flat(), ...others];
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
  skillFile: SourceFile,
  refBoundary: string,
  view: SourceView,
): Promise<readonly CollectedBody[]> {
  const dir = dirname(skillFile.logical);
  const loaded = await readSkillFile({ skillFilePath: skillFile.physical, skillDir: dir });
  if (!loaded.ok) {
    throw new Error(
      `failed to load skill at ${dir}:\n  - ${formatLoadSkillError(loaded.error).join("\n  - ")}`,
    );
  }
  const { skill, body, bodyOffset } = loaded.value;
  const origin = { role: "skill", ownLeaf: basename(dir) } as const;
  const primary: CollectedBody = {
    filePath: skillFile.physical,
    logicalPath: skillFile.logical,
    body,
    bodyOffset,
    refBoundary,
    origin,
  };
  const declared = skill.companions ?? [];
  const companionFile = (file: string): SourceFile => {
    const logical = join(dir, file);
    return { logical, physical: view.physical(logical) };
  };
  const present = await Promise.all(
    declared.map(async (c) => pathExists(companionFile(c.file).physical)),
  );
  const missing = checkCompanionFiles(
    declared,
    declared.filter((_, i) => present[i]).map((c) => c.file),
  );
  if (missing.length > 0) {
    throw new Error(`failed to load skill at ${dir}:\n  - ${missing.join("\n  - ")}`);
  }
  const companions = await Promise.all(
    declared.map(async (companion): Promise<CollectedBody> => {
      const file = companionFile(companion.file);
      return {
        filePath: file.physical,
        logicalPath: file.logical,
        body: await readFile(file.physical, "utf8"),
        bodyOffset: 0,
        refBoundary,
        origin,
      };
    }),
  );
  const frontmatter = frontmatterBodies(
    await readFile(skillFile.physical, "utf8"),
    skillFile,
    [skill.description, ...declared.map((c) => c.summary)],
    origin,
    refBoundary,
  );
  return [primary, ...companions, ...frontmatter];
}

function frontmatterBodies(
  skillText: string,
  skillFile: SourceFile,
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
      filePath: skillFile.physical,
      logicalPath: skillFile.logical,
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
