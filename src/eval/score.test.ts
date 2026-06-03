import { test } from "node:test";
import { strict as assert } from "node:assert";

import type { DetectionResult } from "./detect.js";
import { matchesExpectation, scoreCase, scoreSolving, type SolvingRunResult } from "./score.js";
import type { Expectation } from "./schema.js";

function fired(...observed: string[]): DetectionResult {
  return {
    observed,
    firstSkill: observed[0] ?? null,
    exitReason: observed.length > 0 ? "skill" : "no-skill",
  };
}

test("first expectation matches the exact first skill", () => {
  const expect: Expectation = { first: "alpha:plan" };
  assert.equal(matchesExpectation(expect, fired("alpha:plan")), true);
  assert.equal(matchesExpectation(expect, fired("beta:check")), false);
});

test("not guard fails the match even when the positive condition holds", () => {
  const expect: Expectation = { first: "alpha:plan", not: ["beta:check"] };
  assert.equal(matchesExpectation(expect, fired("beta:check")), false);
});

test("anyOf matches when the first skill is in the set", () => {
  const expect: Expectation = { anyOf: ["alpha:build", "beta:format"] };
  assert.equal(matchesExpectation(expect, fired("alpha:build")), true);
  assert.equal(matchesExpectation(expect, fired("beta:check")), false);
});

test("noSkill matches only when nothing fired", () => {
  const expect: Expectation = { noSkill: true };
  assert.equal(matchesExpectation(expect, fired()), true);
  assert.equal(matchesExpectation(expect, fired("alpha:plan")), false);
});

test("path matches an ordered subsequence regardless of gaps", () => {
  const expect: Expectation = { path: ["alpha:validate", "alpha:plan"] };
  assert.equal(matchesExpectation(expect, fired("alpha:validate", "alpha:plan")), true);
  assert.equal(
    matchesExpectation(expect, fired("alpha:validate", "beta:check", "alpha:plan")),
    true,
  );
});

test("path fails when the order is reversed", () => {
  const expect: Expectation = { path: ["alpha:validate", "alpha:plan"] };
  assert.equal(matchesExpectation(expect, fired("alpha:plan", "alpha:validate")), false);
});

test("scoreCase passes when the trigger rate meets the threshold", () => {
  const expect: Expectation = { first: "alpha:plan" };
  const runs = [fired("alpha:plan"), fired("alpha:plan"), fired("beta:check")];
  const score = scoreCase(expect, runs, 0.6);
  assert.equal(score.matched, 2);
  assert.equal(score.runs, 3);
  assert.ok(Math.abs(score.triggerRate - 2 / 3) < 1e-9);
  assert.equal(score.pass, true);
  assert.equal(score.histogram.get("alpha:plan"), 2);
  assert.equal(score.histogram.get("beta:check"), 1);
});

test("scoreCase fails below the default threshold of 1.0", () => {
  const expect: Expectation = { first: "alpha:plan" };
  const score = scoreCase(expect, [fired("alpha:plan"), fired("beta:check")]);
  assert.equal(score.pass, false);
});

test("scoreCase histogram labels a no-skill run", () => {
  const score = scoreCase({ noSkill: true }, [fired()]);
  assert.equal(score.histogram.get("(no skill)"), 1);
  assert.equal(score.pass, true);
});

function solvingRun(assertionPass: boolean, rubricPass: boolean | null = null): SolvingRunResult {
  return {
    assertions: [
      { assertion: { kind: "usedTool", tool: "Write" }, pass: assertionPass, evidence: "e" },
    ],
    rubric: rubricPass === null ? null : { dimensions: [], pass: rubricPass },
  };
}

test("scoreSolving counts a run as matched only when assertions and the rubric pass", () => {
  const score = scoreSolving(
    [solvingRun(true, true), solvingRun(true, true), solvingRun(false)],
    0.6,
  );
  assert.equal(score.matched, 2);
  assert.equal(score.runs, 3);
  assert.ok(Math.abs(score.triggerRate - 2 / 3) < 1e-9);
  assert.equal(score.pass, true);
});

test("scoreSolving fails a run when the rubric fails even if assertions pass", () => {
  const score = scoreSolving([solvingRun(true, false)]);
  assert.equal(score.matched, 0);
  assert.equal(score.pass, false);
});

test("scoreSolving fails below the default threshold of 1.0", () => {
  const score = scoreSolving([solvingRun(true, true), solvingRun(false)]);
  assert.equal(score.pass, false);
});

test("scoreSolving treats a run with no rubric as passing on assertions alone", () => {
  const score = scoreSolving([solvingRun(true)]);
  assert.equal(score.pass, true);
});

test("scoreSolving reports an empty histogram", () => {
  const score = scoreSolving([solvingRun(true)]);
  assert.equal(score.histogram.size, 0);
});
