import { fileURLToPath } from "node:url";

import promptfoo, { type EvaluateResult, type EvaluateTestSuite } from "promptfoo";

import {
  defaultSources,
  discoverInstalled,
  discoverPluginRoots,
  indexInstalled,
  localSources,
  mergeArtifacts,
  type InstalledArtifacts,
  type InstalledIndex,
} from "../installed.js";
import { err, ok, type Result } from "../result.js";
import {
  loadCases,
  unresolvedSkills,
  type CaseLoadError,
  type LoadedCase,
  type LoadedRoutingCase,
  type LoadedSolvingCase,
} from "./cases.js";
import { compileRouting, compileSolving, type CompileOptions } from "./compile.js";
import { runMetrics } from "./metrics.js";
import { reportCases } from "./outcomes.js";
import { buildReport, type EvalReport } from "./report.js";
import { caseExpectedSkills } from "./schema.js";
import { claude, type EvalVendor } from "./vendors.js";

const DEFAULT_CONCURRENCY = 1;
const DEFAULT_JUDGE_MODEL = "opus";
const ROUTING_TIMEOUT_MS = 60_000;
const DEFAULT_SOLVING_TIMEOUT_MS = 300_000;
const VENDOR_PACKAGE_ROOT = fileURLToPath(new URL("../..", import.meta.url));

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
}

export async function runEval(options: EvalOptions): Promise<Result<EvalReport, CaseLoadError[]>> {
  const loaded = await loadCases(options.casesDir);
  if (!loaded.ok) return err(loaded.error);

  const selected = select(loaded.value, options);
  if (selected.length === 0) {
    return err([{ file: options.casesDir, message: "no cases matched the given filters" }]);
  }

  const installed = indexInstalled(await resolveArtifacts(options.distRoot));
  const unresolved = unresolvedSkills(selected, new Set(installed.skills.keys()));
  if (unresolved.length > 0) return err(unresolved);

  const vendor = claude;
  const compileOptions: CompileOptions = {
    vendor,
    cwd: options.cwd,
    judgeModel: options.judgeModel ?? DEFAULT_JUDGE_MODEL,
    pluginRoots: await localPluginRoots(vendor, options.distRoot),
    enabledPlugins: enabledPluginKeys(selected, installed, vendor),
    ...(options.model !== undefined && { model: options.model }),
    ...(options.runs !== undefined && { runs: options.runs }),
  };
  const routing = selected.filter((c): c is LoadedRoutingCase => c.tier === "routing");
  const solving = selected.filter((c): c is LoadedSolvingCase => c.tier === "solving");
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;

  const rows = [
    ...(await evaluateTier(routing, compileRouting(routing, compileOptions), {
      concurrency,
      timeoutMs: ROUTING_TIMEOUT_MS,
    })),
    ...(await evaluateTier(solving, compileSolving(solving, compileOptions), {
      concurrency,
      timeoutMs: options.solvingTimeoutMs ?? DEFAULT_SOLVING_TIMEOUT_MS,
    })),
  ];

  return ok(buildReport(reportCases(selected, rows), rows.map(runMetrics)));
}

async function resolveArtifacts(distRoot?: string): Promise<InstalledArtifacts> {
  const cache = await discoverInstalled(defaultSources());
  if (distRoot === undefined) return cache;
  const local = await discoverInstalled(await localSources(distRoot));
  return mergeArtifacts(cache, local);
}

async function localPluginRoots(vendor: EvalVendor, distRoot?: string): Promise<string[]> {
  if (distRoot === undefined) return [];
  const sources = (await localSources(distRoot)).filter((source) => source.name === vendor.name);
  const roots = await Promise.all(sources.map(discoverPluginRoots));
  return roots.flat().map((plugin) => plugin.root);
}

export function enabledPluginKeys(
  selected: readonly LoadedCase[],
  index: InstalledIndex,
  vendor: Pick<EvalVendor, "name"> = claude,
): Set<string> {
  const keys = new Set<string>();
  for (const evalCase of selected) {
    for (const id of caseExpectedSkills(evalCase)) {
      for (const entry of [...(index.skills.get(id) ?? []), ...(index.commands.get(id) ?? [])]) {
        if (entry.source === vendor.name && entry.marketplace) {
          keys.add(`${entry.plugin}@${entry.marketplace}`);
        }
      }
    }
  }
  return keys;
}

interface TierRun {
  readonly concurrency: number;
  readonly timeoutMs: number;
}

async function evaluateTier(
  cases: readonly LoadedCase[],
  suite: EvaluateTestSuite,
  run: TierRun,
): Promise<EvaluateResult[]> {
  if (cases.length === 0) return [];
  const evaluation = await promptfoo.evaluate(
    { ...suite, basePath: VENDOR_PACKAGE_ROOT },
    {
      maxConcurrency: run.concurrency,
      timeoutMs: run.timeoutMs,
      cache: false,
    },
  );
  return (await evaluation.toEvaluateSummary()).results;
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
