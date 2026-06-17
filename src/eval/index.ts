import {
  defaultSources,
  discoverInstalled,
  indexInstalled,
  localSources,
  mergeArtifacts,
  type InstalledArtifacts,
  type InstalledIndex,
} from "../installed.js";
import { err, ok, type Result } from "../result.js";
import { loadCases, unresolvedSkills, type CaseLoadError, type LoadedCase } from "./cases.js";
import { caseExpectedSkills } from "./schema.js";
import { gradeResults } from "./grade/index.js";
import { DEFAULT_JUDGE_MODEL, selectJudge, type Judge } from "./judge/index.js";
import { buildReport, type EvalReport } from "./report.js";
import { runCases, type RunnerOptions } from "./runner.js";

export interface EvalOptions {
  readonly casesDir: string;
  readonly cwd: string;
  readonly distRoot?: string;
  readonly suite?: string;
  readonly caseId?: string;
  readonly tier?: LoadedCase["tier"];
  readonly runs?: number;
  readonly concurrency?: number;
  readonly model?: string;
  readonly judgeModel?: string;
  readonly solvingTimeoutMs?: number;
  readonly judge?: Judge;
  readonly onRun?: RunnerOptions["onRun"];
}

export async function runEval(options: EvalOptions): Promise<Result<EvalReport, CaseLoadError[]>> {
  const loaded = await loadCases(options.casesDir);
  if (!loaded.ok) return err(loaded.error);

  const selected = select(loaded.value, options);
  if (selected.length === 0) {
    return err([{ file: options.casesDir, message: "no cases matched the given filters" }]);
  }

  const installed = indexInstalled(await resolveArtifacts(options.distRoot));
  const installedIds = new Set(installed.skills.keys());
  const unresolved = unresolvedSkills(selected, installedIds);
  if (unresolved.length > 0) return err(unresolved);

  const judge = resolveJudge(selected, options);
  const enabledPlugins = enabledPluginKeys(selected, installed);

  const runnerOptions: RunnerOptions = {
    cwd: options.cwd,
    ...(options.runs !== undefined && { runs: options.runs }),
    ...(options.concurrency !== undefined && { concurrency: options.concurrency }),
    ...(options.model !== undefined && { model: options.model }),
    ...(options.solvingTimeoutMs !== undefined && { solvingTimeoutMs: options.solvingTimeoutMs }),
    ...(options.onRun !== undefined && { onRun: options.onRun }),
    ...(enabledPlugins.size > 0 && { enabledPlugins }),
  };
  const { results, metrics } = await runCases(selected, runnerOptions);
  const reports = await gradeResults(results, judge);

  return ok(buildReport(reports, metrics));
}

async function resolveArtifacts(distRoot?: string): Promise<InstalledArtifacts> {
  const cache = await discoverInstalled(defaultSources());
  if (distRoot === undefined) return cache;
  const local = await discoverInstalled(await localSources(distRoot));
  return mergeArtifacts(cache, local);
}

const EVAL_VENDOR = "claude";

export function enabledPluginKeys(
  selected: readonly LoadedCase[],
  index: InstalledIndex,
): Set<string> {
  const keys = new Set<string>();
  for (const evalCase of selected) {
    for (const id of caseExpectedSkills(evalCase)) {
      for (const entry of index.skills.get(id) ?? []) {
        if (entry.source === EVAL_VENDOR && entry.marketplace) {
          keys.add(`${entry.plugin}@${entry.marketplace}`);
        }
      }
    }
  }
  return keys;
}

function needsJudge(cases: readonly LoadedCase[]): boolean {
  return cases.some((c) => c.tier === "solving" && c.rubric !== undefined);
}

function resolveJudge(cases: readonly LoadedCase[], options: EvalOptions): Judge | undefined {
  if (!needsJudge(cases)) return undefined;
  return selectJudge({
    model: options.judgeModel ?? DEFAULT_JUDGE_MODEL,
    ...(options.judge !== undefined && { override: options.judge }),
  });
}

function select(cases: readonly LoadedCase[], options: EvalOptions): LoadedCase[] {
  return cases.filter((evalCase) => {
    if (options.caseId && evalCase.id !== options.caseId) return false;
    if (options.suite && evalCase.suite !== options.suite) return false;
    if (options.tier && evalCase.tier !== options.tier) return false;
    return true;
  });
}

export type { EvalReport, CaseReport } from "./report.js";
export { formatConsole, toJson } from "./report.js";
export type { LoadedCase, CaseLoadError } from "./cases.js";
