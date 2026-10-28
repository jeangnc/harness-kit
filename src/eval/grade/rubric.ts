import type { CombineRule, Rubric } from "../schema.js";

export interface Verdict {
  readonly pass: boolean | "unknown";
  readonly evidence: string;
}

export interface DimensionResult {
  readonly dimension: string;
  readonly verdict: Verdict;
}

export interface RubricResult {
  readonly dimensions: readonly DimensionResult[];
  readonly pass: boolean;
}

export function combineRubric(
  rubric: Rubric,
  verdicts: ReadonlyArray<Verdict | undefined>,
): RubricResult {
  const dimensions = rubric.dimensions.map(({ dimension }, index) => ({
    dimension,
    verdict: verdicts[index] ?? { pass: "unknown" as const, evidence: "judge returned no verdict" },
  }));
  return { dimensions, pass: combine(rubric.combine, dimensions) };
}

function combine(rule: CombineRule, dimensions: readonly DimensionResult[]): boolean {
  const passed = dimensions.filter((d) => d.verdict.pass === true).length;
  if (rule.combine === "all") return passed === dimensions.length;
  return dimensions.length > 0 && passed / dimensions.length >= rule.threshold;
}
