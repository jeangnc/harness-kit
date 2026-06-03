import type { Judge, Verdict } from "./judge.js";
import type { CombineRule, Rubric } from "./schema.js";

export interface DimensionResult {
  readonly dimension: string;
  readonly verdict: Verdict;
}

export interface RubricResult {
  readonly dimensions: readonly DimensionResult[];
  readonly pass: boolean;
}

export async function gradeRubric(
  rubric: Rubric,
  output: string,
  judge: Judge,
): Promise<RubricResult> {
  const dimensions = await Promise.all(
    rubric.dimensions.map(async ({ dimension, criterion }) => ({
      dimension,
      verdict: await judge({ dimension, criterion, output }),
    })),
  );
  return { dimensions, pass: combine(rubric.combine, dimensions) };
}

function combine(rule: CombineRule, dimensions: readonly DimensionResult[]): boolean {
  const passed = dimensions.filter((d) => d.verdict.pass === true).length;
  if (rule.combine === "all") return passed === dimensions.length;
  return dimensions.length > 0 && passed / dimensions.length >= rule.threshold;
}
