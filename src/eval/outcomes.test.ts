import { test } from "node:test";
import { strict as assert } from "node:assert";

import { ResultFailureReason, type EvaluateResult, type GradingResult } from "promptfoo";

import type { LoadedRoutingCase, LoadedSolvingCase } from "./cases.js";
import { metricNames } from "./compile.js";
import { reportCases } from "./outcomes.js";

function routing(): LoadedRoutingCase {
  return {
    id: "r1",
    prompt: "p",
    expect: { first: "alpha:plan" },
    suite: "s",
    tier: "routing",
    file: "f.yaml",
  };
}

function solving(partial: Partial<LoadedSolvingCase> = {}): LoadedSolvingCase {
  return {
    id: "s1",
    prompt: "p",
    assert: [],
    suite: "s",
    tier: "solving",
    file: "f.yaml",
    ...partial,
  };
}

function component(
  metric: string,
  pass: boolean,
  extra: Partial<GradingResult> = {},
): GradingResult {
  return {
    pass,
    score: pass ? 1 : 0,
    reason: `${metric} ${pass}`,
    assertion: { type: "javascript", metric },
    ...extra,
  };
}

function row(caseId: string, partial: Partial<EvaluateResult> = {}): EvaluateResult {
  return {
    provider: { id: "agent", label: "case-0" },
    testCase: { metadata: { caseId } },
    latencyMs: 10,
    ...partial,
  } as EvaluateResult;
}

function skillRow(caseId: string, ...skills: string[]): EvaluateResult {
  const toolCalls = skills.map((skill) => ({ name: "Skill", input: { skill } }));
  return row(caseId, { response: { output: "", metadata: { toolCalls } } });
}

function graded(
  caseId: string,
  components: GradingResult[],
  partial: Partial<EvaluateResult> = {},
) {
  return row(caseId, {
    gradingResult: { pass: true, score: 1, reason: "", componentResults: components },
    ...partial,
  });
}

test("reportCases scores routing runs from the skills each row invoked", () => {
  const [report] = reportCases(
    [routing()],
    [skillRow("r1", "alpha:plan"), skillRow("r1", "beta:check")],
  );
  assert.equal(report!.score.matched, 1);
  assert.equal(report!.score.runs, 2);
});

test("reportCases ignores rows that belong to another case", () => {
  const [report] = reportCases([routing()], [skillRow("other", "alpha:plan")]);
  assert.equal(report!.score.runs, 0);
});

test("reportCases treats a timed-out routing row as a run with no skill", () => {
  const [report] = reportCases(
    [routing()],
    [
      row("r1", {
        error: "Evaluation timed out after 60000ms",
        failureReason: ResultFailureReason.ERROR,
      }),
    ],
  );
  assert.equal(report!.score.histogram.get("(no skill)"), 1);
});

test("reportCases counts a failed routing session as an unmatched error run", () => {
  const [report] = reportCases(
    [{ ...routing(), expect: { noSkill: true } }],
    [row("r1", { error: "sdk missing\ndetails", failureReason: ResultFailureReason.ERROR })],
  );
  assert.equal(report!.score.matched, 0);
  assert.equal(report!.score.histogram.get("(error) sdk missing"), 1);
});

test("reportCases scores the skills a failed routing session invoked before failing", () => {
  const failed = skillRow("r1", "alpha:plan");
  const [report] = reportCases(
    [routing()],
    [{ ...failed, error: "error_max_turns", failureReason: ResultFailureReason.ERROR }],
  );
  assert.equal(report!.score.matched, 1);
});

test("reportCases marks a solving run without an answer as not found", () => {
  const [report] = reportCases([solving()], [graded("s1", [component(metricNames.answer, false)])]);
  assert.deepEqual(report!.solving!.perRun, [{ found: false }]);
});

test("reportCases carries the row error on a solving run that never produced output", () => {
  const [report] = reportCases([solving()], [row("s1", { error: "timed out" })]);
  assert.deepEqual(report!.solving!.perRun, [{ found: false, error: "timed out" }]);
});

test("reportCases maps assertion components back to the case assertions in order", () => {
  const evalCase = solving({ assert: [{ kind: "usedTool", tool: "Write" }] });
  const [report] = reportCases(
    [evalCase],
    [
      graded("s1", [
        component(metricNames.answer, true),
        component(metricNames.assertion(0), false),
      ]),
    ],
  );
  const run = report!.solving!.perRun[0]!;
  assert.ok(run.found);
  assert.deepEqual(run.assertions, [
    { assertion: { kind: "usedTool", tool: "Write" }, pass: false, evidence: "assert:0 false" },
  ]);
});

test("reportCases maps a grader error to an abstaining rubric verdict", () => {
  const evalCase = solving({
    rubric: { dimensions: [{ dimension: "clarity", criterion: "c" }], combine: { combine: "all" } },
  });
  const [report] = reportCases(
    [evalCase],
    [
      graded("s1", [
        component(metricNames.answer, true),
        component(metricNames.rubric(0), false, { metadata: { graderError: true } }),
      ]),
    ],
  );
  const run = report!.solving!.perRun[0]!;
  assert.ok(run.found);
  assert.equal(run.rubric!.dimensions[0]!.verdict.pass, "unknown");
});

test("reportCases passes a solving run when the answer, assertions and rubric pass", () => {
  const evalCase = solving({
    assert: [{ kind: "usedTool", tool: "Write" }],
    rubric: { dimensions: [{ dimension: "clarity", criterion: "c" }], combine: { combine: "all" } },
  });
  const [report] = reportCases(
    [evalCase],
    [
      graded("s1", [
        component(metricNames.answer, true),
        component(metricNames.assertion(0), true),
        component(metricNames.rubric(0), true),
      ]),
    ],
  );
  assert.equal(report!.score.pass, true);
});
