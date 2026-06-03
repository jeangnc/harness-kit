import { test } from "node:test";
import { strict as assert } from "node:assert";

import type { SolvingCapture } from "./capture.js";
import type { CaseResult } from "./runner.js";
import { gradeResults } from "./grade.js";
import type { Judge } from "./judge.js";
import type { LoadedRoutingCase, LoadedSolvingCase } from "./cases.js";

const passJudge: Judge = async () => ({ pass: true, evidence: "ok" });

function solvingCase(partial: Partial<LoadedSolvingCase>): LoadedSolvingCase {
  return {
    id: "s1",
    prompt: "p",
    assert: [],
    suite: "suite",
    tier: "solving",
    file: "f.yaml",
    ...partial,
  };
}

function capture(partial: Partial<SolvingCapture>): SolvingCapture {
  return { outputText: "", trajectory: [], writes: [], exitReason: "result", ...partial };
}

test("gradeResults scores a routing case via the routing scorer", async () => {
  const evalCase: LoadedRoutingCase = {
    id: "r1",
    prompt: "p",
    expect: { first: "alpha:plan" },
    suite: "suite",
    tier: "routing",
    file: "f.yaml",
  };
  const result: CaseResult = {
    tier: "routing",
    evalCase,
    runs: [{ observed: ["alpha:plan"], firstSkill: "alpha:plan", exitReason: "skill" }],
  };
  const [report] = await gradeResults([result], passJudge);
  assert.equal(report!.score.pass, true);
  assert.equal(report!.solving, undefined);
});

test("gradeResults grades solving assertions and attaches a breakdown", async () => {
  const evalCase = solvingCase({ assert: [{ kind: "usedTool", tool: "Write" }] });
  const result: CaseResult = {
    tier: "solving",
    evalCase,
    captures: [capture({ trajectory: [{ name: "Write", input: {} }] })],
  };
  const [report] = await gradeResults([result], passJudge);
  assert.equal(report!.score.pass, true);
  assert.equal(report!.solving?.perRun.length, 1);
  assert.equal(report!.solving?.perRun[0]!.assertions[0]!.pass, true);
});

test("gradeResults fails a solving case when an assertion fails", async () => {
  const evalCase = solvingCase({ assert: [{ kind: "usedTool", tool: "Write" }] });
  const result: CaseResult = {
    tier: "solving",
    evalCase,
    captures: [capture({ trajectory: [{ name: "Read", input: {} }] })],
  };
  const [report] = await gradeResults([result], passJudge);
  assert.equal(report!.score.pass, false);
});

test("gradeResults invokes the judge for a rubric and reflects its verdict", async () => {
  const calls: string[] = [];
  const judge: Judge = async ({ dimension }) => {
    calls.push(dimension);
    return { pass: false, evidence: "weak" };
  };
  const evalCase = solvingCase({
    assert: [],
    rubric: {
      dimensions: [{ dimension: "clarity", criterion: "clear" }],
      combine: { combine: "all" },
    },
  });
  const result: CaseResult = {
    tier: "solving",
    evalCase,
    captures: [capture({ outputText: "x" })],
  };
  const [report] = await gradeResults([result], judge);
  assert.deepEqual(calls, ["clarity"]);
  assert.equal(report!.score.pass, false);
  assert.equal(report!.solving?.perRun[0]!.rubric?.pass, false);
});

test("gradeResults does not call the judge for an assertion-only solving case", async () => {
  let called = false;
  const judge: Judge = async () => {
    called = true;
    return { pass: true, evidence: "" };
  };
  const evalCase = solvingCase({ assert: [{ kind: "usedTool", tool: "Read" }] });
  const result: CaseResult = {
    tier: "solving",
    evalCase,
    captures: [capture({ trajectory: [{ name: "Read", input: {} }] })],
  };
  await gradeResults([result], judge);
  assert.equal(called, false);
});
