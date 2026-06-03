import type { SolvingCapture } from "./capture.js";
import { gradeAssertions } from "./grade-deterministic.js";
import { gradeRubric, type RubricResult } from "./grade-judge.js";
import type { Judge } from "./judge.js";
import type { CaseReport } from "./report.js";
import type { CaseResult } from "./runner.js";
import { scoreCase, scoreSolving, type SolvingRunResult } from "./score.js";
import type { Assertion, Rubric } from "./schema.js";

export async function gradeResults(
  results: readonly CaseResult[],
  judge: Judge | undefined,
): Promise<CaseReport[]> {
  return Promise.all(results.map(async (result) => gradeOne(result, judge)));
}

async function gradeOne(result: CaseResult, judge: Judge | undefined): Promise<CaseReport> {
  if (result.tier === "routing") {
    const { evalCase, runs } = result;
    return { evalCase, score: scoreCase(evalCase.expect, runs, evalCase.threshold) };
  }

  const { evalCase, captures } = result;
  const perRun = await Promise.all(
    captures.map(async (capture) => gradeRun(evalCase.assert, evalCase.rubric, capture, judge)),
  );
  return {
    evalCase,
    score: scoreSolving(perRun, evalCase.threshold),
    solving: { perRun },
  };
}

async function gradeRun(
  assertions: readonly Assertion[],
  rubric: Rubric | undefined,
  capture: SolvingCapture,
  judge: Judge | undefined,
): Promise<SolvingRunResult> {
  const graded = gradeAssertions(assertions, capture);
  const rubricResult: RubricResult | null =
    rubric && judge ? await gradeRubric(rubric, capture.outputText, judge) : null;
  return { assertions: graded, rubric: rubricResult };
}
