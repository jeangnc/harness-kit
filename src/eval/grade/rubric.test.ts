import { test } from "node:test";
import { strict as assert } from "node:assert";

import { combineRubric, type Verdict } from "./rubric.js";
import type { Rubric } from "../schema.js";

function rubric(combine: Rubric["combine"], ...dimensions: string[]): Rubric {
  return {
    dimensions: dimensions.map((dimension) => ({ dimension, criterion: `${dimension} criterion` })),
    combine,
  };
}

const yes: Verdict = { pass: true, evidence: "" };
const no: Verdict = { pass: false, evidence: "" };
const unsure: Verdict = { pass: "unknown", evidence: "cannot tell" };

test("combineRubric names each verdict after its dimension in rubric order", () => {
  const result = combineRubric(rubric({ combine: "all" }, "clarity", "accuracy"), [yes, no]);
  assert.deepEqual(
    result.dimensions.map((d) => [d.dimension, d.verdict.pass]),
    [
      ["clarity", true],
      ["accuracy", false],
    ],
  );
});

test("combine all passes when every dimension passes", () => {
  assert.equal(combineRubric(rubric({ combine: "all" }, "a", "b"), [yes, yes]).pass, true);
});

test("combine all fails when one dimension fails", () => {
  assert.equal(combineRubric(rubric({ combine: "all" }, "a", "b"), [yes, no]).pass, false);
});

test("an abstain verdict never counts as a pass under combine all", () => {
  assert.equal(combineRubric(rubric({ combine: "all" }, "a", "b"), [yes, unsure]).pass, false);
});

test("a missing verdict abstains", () => {
  const result = combineRubric(rubric({ combine: "all" }, "a"), []);
  assert.equal(result.dimensions[0]!.verdict.pass, "unknown");
});

test("combine fraction passes when the pass ratio meets the threshold", () => {
  const r = rubric({ combine: "fraction", threshold: 0.5 }, "a", "b", "c");
  assert.equal(combineRubric(r, [yes, yes, no]).pass, true);
});

test("combine fraction fails below the threshold and counts abstain in the denominator", () => {
  const r = rubric({ combine: "fraction", threshold: 0.5 }, "a", "b", "c");
  assert.equal(combineRubric(r, [yes, unsure, no]).pass, false);
});
