import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

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
  loadLayout,
  type LayoutAdapter,
  type LocalIds,
  type ResolvedPlugin,
} from "../layout/index.js";
import {
  defaultSources,
  discoverInstalled,
  indexInstalled,
  type InstalledIndex,
  type PluginSource,
} from "../installed.js";

import { detectBypasses, type BypassHaystacks } from "./bypass.js";
import {
  unifiedKindConfigs,
  type HaystackScope,
  type KindConfig,
  type ReferencePrefix,
} from "./kinds.js";
import { closestMatch } from "./suggest.js";

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

export const CHECK_MODES = ["local", "installed", "all"] as const;
export type CheckMode = (typeof CHECK_MODES)[number];

export interface CheckOptions {
  readonly srcRoot: string;
  readonly mode?: CheckMode;
  readonly sources?: readonly PluginSource[];
}

export type ReferenceViolationKind = "malformed" | "unresolved";

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
  readonly prefix: ReferencePrefix;
  readonly id: string;
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly message: string;
}

export interface CheckResult {
  readonly violations: readonly ReferenceViolation[];
  readonly warnings: readonly BypassWarning[];
  readonly checkedFiles: number;
  readonly indexedSources: readonly SourceSummary[];
}

interface BodySource {
  readonly body: string;
  readonly bodyOffset: number;
  readonly fileText: string;
  readonly filePath: string;
}

export async function check(options: CheckOptions): Promise<CheckResult> {
  const mode: CheckMode = options.mode ?? "installed";
  let indexedSources: readonly SourceSummary[] = [];
  let localAdapter: LayoutAdapter | null = null;
  let installedIndex: InstalledIndex = EMPTY_INSTALLED_INDEX;
  let localIds: LocalIds = EMPTY_LOCAL_IDS;

  if (mode === "installed" || mode === "all") {
    const sources = options.sources ?? defaultSources();
    const artifacts = await discoverInstalled(sources);
    installedIndex = indexInstalled(artifacts);
    indexedSources = sources.map<SourceSummary>((s) => ({
      source: s.name,
      skillCount: artifacts.skills.filter((i) => i.source === s.name).length,
    }));
  }

  if (mode === "local" || mode === "all") {
    const loaded = await loadLayout(options.srcRoot);
    if (!loaded.ok) throw new Error(`failed to load layout: ${loaded.error.kind}`);
    localAdapter = loaded.value;
    localIds = await collectLocalIds(localAdapter);
  }

  const kinds = unifiedKindConfigs(localIds, installedIndex, mode satisfies HaystackScope);
  const haystacks = bypassHaystacks(kinds);

  const sources = await collectBodySources({
    srcRoot: options.srcRoot,
    mode,
    adapter: localAdapter,
  });
  const violations: ReferenceViolation[] = [];
  const warnings: BypassWarning[] = [];
  for (const source of sources) {
    for (const violation of validateBody(source, kinds)) {
      violations.push(violation);
    }
    for (const warning of findBypasses(source, haystacks)) {
      warnings.push(warning);
    }
  }

  return { violations, warnings, checkedFiles: sources.length, indexedSources };
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
      prefix: bypass.prefix,
      id: bypass.id,
      file: source.filePath,
      line,
      column,
      message: `\`${bypass.id}\` ${bypass.prefix} referenced directly — use \`{{${bypass.prefix}:${bypass.id}}}\` so harness-kit can track it`,
    };
  });
}

interface CollectOptions {
  readonly srcRoot: string;
  readonly mode: CheckMode;
  readonly adapter: LayoutAdapter | null;
}

async function collectBodySources(opts: CollectOptions): Promise<readonly BodySource[]> {
  const seen = new Set<string>();
  const out: BodySource[] = [];
  const push = async (filePath: string, body: string, bodyOffset: number): Promise<void> => {
    if (seen.has(filePath)) return;
    seen.add(filePath);
    const fileText = await readFile(filePath, "utf8");
    out.push({ body, bodyOffset, fileText, filePath });
  };

  if (opts.mode === "installed" || opts.mode === "all") {
    for await (const skillDir of findSkillDirs(opts.srcRoot)) {
      for (const file of await loadSkillBodies(skillDir)) {
        await push(file.filePath, file.body, file.bodyOffset);
      }
    }
  }

  if ((opts.mode === "local" || opts.mode === "all") && opts.adapter) {
    for (const plugin of opts.adapter.plugins) {
      for (const file of await collectPluginBodies(plugin)) {
        await push(file.filePath, file.body, file.bodyOffset);
      }
    }
  }

  return out;
}

interface PluginBody {
  readonly filePath: string;
  readonly body: string;
  readonly bodyOffset: number;
}

async function collectPluginBodies(plugin: ResolvedPlugin): Promise<readonly PluginBody[]> {
  const out: PluginBody[] = [];
  if (await pathExists(plugin.skillsDir)) {
    for (const entry of await readdir(plugin.skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const skillDir = join(plugin.skillsDir, entry.name);
      const found = await findSkillFile(skillDir);
      if (!found.ok || !found.value) continue;
      out.push(...(await loadSkillBodies(skillDir)));
    }
  }
  for (const dir of [plugin.commandsDir, plugin.agentsDir]) {
    if (!(await pathExists(dir))) continue;
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const filePath = join(dir, entry.name);
      const body = await readFile(filePath, "utf8");
      out.push({ filePath, body, bodyOffset: 0 });
    }
  }
  return out;
}

async function loadSkillBodies(skillDir: string): Promise<readonly PluginBody[]> {
  const loaded = await loadSkill(skillDir);
  if (!loaded.ok) {
    throw new Error(
      `failed to load skill at ${skillDir}:\n  - ${formatLoadSkillError(loaded.error).join("\n  - ")}`,
    );
  }
  const { skill, body, bodyFilePath, bodyOffset, skillDir: dir } = loaded.value;
  const primary: PluginBody = { filePath: bodyFilePath, body, bodyOffset };
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
      return { filePath, body: await readFile(filePath, "utf8"), bodyOffset: 0 };
    }),
  );
  return [primary, ...companions];
}

function validateBody(
  source: BodySource,
  kinds: ReadonlyMap<string, KindConfig>,
): readonly ReferenceViolation[] {
  const violations: ReferenceViolation[] = [];
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
    violations.push({
      ...at,
      kind: "unresolved",
      message: suggestion
        ? `\`${token.value}\` ${kind.noun} ${kind.missingHint} (did you mean \`${suggestion}\`?)`
        : `\`${token.value}\` ${kind.noun} ${kind.missingHint}`,
    });
  }
  return violations;
}

async function* findSkillDirs(srcRoot: string): AsyncGenerator<string> {
  if (!(await pathExists(srcRoot))) return;
  for await (const dir of walkDirs(srcRoot)) {
    const found = await findSkillFile(dir);
    if (!found.ok || found.value) yield dir;
  }
}

async function* walkDirs(dir: string): AsyncGenerator<string> {
  yield dir;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      yield* walkDirs(join(dir, entry.name));
    }
  }
}
