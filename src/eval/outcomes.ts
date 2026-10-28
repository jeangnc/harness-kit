import { ResultFailureReason, type EvaluateResult, type GradingResult } from "promptfoo";

import type { LoadedCase, LoadedRoutingCase, LoadedSolvingCase } from "./cases.js";
import { metricNames } from "./compile.js";
import { detectSkills } from "./detect.js";
import { combineRubric, type Verdict } from "./grade/index.js";
import type { CaseReport } from "./report.js";
import { scoreCase, scoreSolving, type RoutingRun, type SolvingRunResult } from "./score.js";
import { trajectoryOf } from "./trajectory.js";

const TIMEOUT_ERROR_PREFIX = "Evaluation timed out";

export function reportCases(
  cases: readonly LoadedCase[],
  rows: readonly EvaluateResult[],
): CaseReport[] {
  return cases.map((evalCase) =>
    reportCase(
      evalCase,
      rows.filter((row) => row.testCase.metadata?.["caseId"] === evalCase.id),
    ),
  );
}

function reportCase(evalCase: LoadedCase, rows: readonly EvaluateResult[]): CaseReport {
  return evalCase.tier === "routing"
    ? routingReport(evalCase, rows)
    : solvingReport(evalCase, rows);
}

function routingReport(evalCase: LoadedRoutingCase, rows: readonly EvaluateResult[]): CaseReport {
  const runs = rows.map(routingRun);
  return { evalCase, score: scoreCase(evalCase.expect, runs, evalCase.threshold) };
}

function routingRun(row: EvaluateResult): RoutingRun {
  if (isUnobservedFailure(row)) return { error: row.error ?? "agent session failed" };
  return detectSkills(trajectoryOf(row.response?.metadata));
}

function isUnobservedFailure(row: EvaluateResult): boolean {
  if (row.failureReason !== ResultFailureReason.ERROR) return false;
  return !row.error?.startsWith(TIMEOUT_ERROR_PREFIX);
}

function solvingReport(evalCase: LoadedSolvingCase, rows: readonly EvaluateResult[]): CaseReport {
  const perRun = rows.map((row) => solvingRun(evalCase, row));
  return { evalCase, score: scoreSolving(perRun, evalCase.threshold), solving: { perRun } };
}

function solvingRun(evalCase: LoadedSolvingCase, row: EvaluateResult): SolvingRunResult {
  const components = new Map(
    (row.gradingResult?.componentResults ?? []).map((c) => [c.assertion?.metric, c]),
  );
  if (components.get(metricNames.answer)?.pass !== true) {
    return row.error ? { found: false, error: row.error } : { found: false };
  }
  return {
    found: true,
    assertions: evalCase.assert.map((assertion, index) => {
      const component = components.get(metricNames.assertion(index));
      return {
        assertion,
        pass: component?.pass === true,
        evidence: component?.reason ?? "assertion was not graded",
      };
    }),
    rubric: evalCase.rubric
      ? combineRubric(
          evalCase.rubric,
          evalCase.rubric.dimensions.map((_, index) =>
            verdictOf(components.get(metricNames.rubric(index))),
          ),
        )
      : null,
  };
}

function verdictOf(component: GradingResult | undefined): Verdict | undefined {
  if (component === undefined) return undefined;
  if (component.metadata?.graderError) return { pass: "unknown", evidence: component.reason };
  return { pass: component.pass, evidence: component.reason };
}
