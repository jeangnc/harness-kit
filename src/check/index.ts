import { readFile, readdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

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

interface BodySource {
  readonly body: string;
  readonly bodyOffset: number;
  readonly fileText: string;
  readonly filePath: string;
  readonly pluginDir: string;
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

  const bodies = await collectBodySources(localAdapter);
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
    for (const violation of await findUnresolvedRefs(source)) {
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

async function findUnresolvedRefs(source: BodySource): Promise<readonly ReferenceViolation[]> {
  const violations: ReferenceViolation[] = [];
  const sourceDir = dirname(source.filePath);
  for (const token of parsePlaceholders(source.body)) {
    if (token.prefix !== "ref" || token.value === null) continue;
    const target = resolve(sourceDir, token.value);
    const problem = await refProblem(target, source.pluginDir);
    if (problem === null) continue;
    const { line, column } = offsetToLineCol(source.fileText, source.bodyOffset + token.start);
    violations.push({
      kind: "unresolved",
      token: token.value,
      file: source.filePath,
      line,
      column,
      message: `\`${token.value}\` ref ${problem}`,
    });
  }
  return violations;
}

async function refProblem(target: string, pluginDir: string): Promise<string | null> {
  const inPlugin = target === pluginDir || target.startsWith(`${pluginDir}/`);
  if (!inPlugin) {
    return "resolves outside its plugin — `{{ref:}}` is same-plugin only, and the installed layout nests each plugin under a version directory that `src/` does not have";
  }
  if (!(await pathExists(target))) return "points at a file that does not exist";
  return null;
}

async function collectBodySources(adapter: LayoutAdapter): Promise<readonly BodySource[]> {
  const seen = new Set<string>();
  const out: BodySource[] = [];
  const push = async (file: PluginBody): Promise<void> => {
    const key = `${file.filePath}:${file.bodyOffset}:${file.body.length}`;
    if (seen.has(key)) return;
    seen.add(key);
    const fileText = await readFile(file.filePath, "utf8");
    out.push({
      body: file.body,
      bodyOffset: file.bodyOffset,
      fileText,
      filePath: file.filePath,
      pluginDir: file.pluginDir,
      origin: file.origin,
      frontmatter: file.frontmatter ?? false,
    });
  };

  for (const plugin of adapter.plugins) {
    for (const file of await collectPluginBodies(plugin)) {
      await push(file);
    }
  }

  return out;
}

interface PluginBody {
  readonly filePath: string;
  readonly body: string;
  readonly bodyOffset: number;
  readonly pluginDir: string;
  readonly origin: BodyOrigin;
  readonly frontmatter?: boolean;
}

async function collectPluginBodies(plugin: ResolvedPlugin): Promise<readonly PluginBody[]> {
  const out: PluginBody[] = [];
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
    out.push({ filePath, body, bodyOffset: 0, pluginDir: plugin.pluginDir, origin: { role } });
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
  pluginDir: string,
): Promise<readonly PluginBody[]> {
  const loaded = await loadSkill(skillDir);
  if (!loaded.ok) {
    throw new Error(
      `failed to load skill at ${skillDir}:\n  - ${formatLoadSkillError(loaded.error).join("\n  - ")}`,
    );
  }
  const { skill, body, bodyFilePath, bodyOffset, skillDir: dir } = loaded.value;
  const origin = { role: "skill", ownLeaf: basename(dir) } as const;
  const primary: PluginBody = { filePath: bodyFilePath, body, bodyOffset, pluginDir, origin };
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
    declared.map(async (companion): Promise<PluginBody> => {
      const filePath = join(dir, companion.file);
      return {
        filePath,
        body: await readFile(filePath, "utf8"),
        bodyOffset: 0,
        pluginDir,
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
    pluginDir,
  );
  return [primary, ...companions, ...frontmatter];
}

function frontmatterBodies(
  skillText: string,
  skillFilePath: string,
  values: readonly string[],
  origin: BodyOrigin,
  pluginDir: string,
): readonly PluginBody[] {
  const bodies: PluginBody[] = [];
  let cursor = 0;
  for (const value of values) {
    const at = skillText.indexOf(value, cursor);
    if (at === -1) continue;
    cursor = at + value.length;
    bodies.push({
      filePath: skillFilePath,
      body: value,
      bodyOffset: at,
      pluginDir,
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
