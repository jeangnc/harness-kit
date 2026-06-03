import type { DetectionResult } from "./detect.js";
import type { AssertionResult } from "./grade-deterministic.js";
import type { RubricResult } from "./grade-judge.js";
import type { Expectation } from "./schema.js";

const DEFAULT_THRESHOLD = 1.0;

export interface CaseScore {
  readonly matched: number;
  readonly runs: number;
  readonly triggerRate: number;
  readonly threshold: number;
  readonly pass: boolean;
  readonly histogram: ReadonlyMap<string, number>;
}

export function matchesExpectation(expectation: Expectation, run: DetectionResult): boolean {
  if (violatesNot(expectation, run)) return false;

  if ("noSkill" in expectation) {
    return run.firstSkill === null;
  }
  if ("first" in expectation) {
    return run.firstSkill === expectation.first;
  }
  if ("anyOf" in expectation) {
    return run.firstSkill !== null && expectation.anyOf.includes(run.firstSkill);
  }
  return isOrderedSubsequence(expectation.path, run.observed);
}

export function scoreCase(
  expectation: Expectation,
  runs: readonly DetectionResult[],
  threshold = DEFAULT_THRESHOLD,
): CaseScore {
  const matched = runs.filter((run) => matchesExpectation(expectation, run)).length;
  const triggerRate = runs.length === 0 ? 0 : matched / runs.length;
  return {
    matched,
    runs: runs.length,
    triggerRate,
    threshold,
    pass: triggerRate >= threshold,
    histogram: histogramOf(runs),
  };
}

export interface SolvingRunResult {
  readonly assertions: readonly AssertionResult[];
  readonly rubric: RubricResult | null;
}

export function solvingRunPassed(run: SolvingRunResult): boolean {
  const assertionsPass = run.assertions.every((a) => a.pass);
  const rubricPass = run.rubric === null || run.rubric.pass;
  return assertionsPass && rubricPass;
}

export function scoreSolving(
  perRun: readonly SolvingRunResult[],
  threshold = DEFAULT_THRESHOLD,
): CaseScore {
  const matched = perRun.filter(solvingRunPassed).length;
  const triggerRate = perRun.length === 0 ? 0 : matched / perRun.length;
  return {
    matched,
    runs: perRun.length,
    triggerRate,
    threshold,
    pass: triggerRate >= threshold,
    histogram: new Map(),
  };
}

function violatesNot(expectation: Expectation, run: DetectionResult): boolean {
  const forbidden = "noSkill" in expectation ? undefined : expectation.not;
  if (!forbidden || forbidden.length === 0) return false;
  return run.firstSkill !== null && forbidden.includes(run.firstSkill);
}

function isOrderedSubsequence(needle: readonly string[], haystack: readonly string[]): boolean {
  let cursor = 0;
  for (const id of haystack) {
    if (id === needle[cursor]) cursor += 1;
    if (cursor === needle.length) return true;
  }
  return cursor === needle.length;
}

function histogramOf(runs: readonly DetectionResult[]): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const run of runs) {
    const key = run.firstSkill ?? "(no skill)";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}
