import { test } from "node:test";
import { strict as assert } from "node:assert";

import { gradeRubric } from "./grade-judge.js";
import type { Judge, JudgeRequest, Verdict } from "./judge.js";
import type { Rubric } from "./schema.js";

function rubric(combine: Rubric["combine"], ...dimensions: string[]): Rubric {
  return {
    dimensions: dimensions.map((dimension) => ({ dimension, criterion: `${dimension} criterion` })),
    combine,
  };
}

function judgeReturning(verdicts: Record<string, Verdict>): {
  judge: Judge;
  calls: JudgeRequest[];
} {
  const calls: JudgeRequest[] = [];
  const judge: Judge = async (request) => {
    calls.push(request);
    return verdicts[request.dimension] ?? { pass: "unknown", evidence: "no stub" };
  };
  return { judge, calls };
}

test("gradeRubric calls the judge once per dimension in isolation", async () => {
  const { judge, calls } = judgeReturning({
    clarity: { pass: true, evidence: "a" },
    accuracy: { pass: true, evidence: "b" },
  });
  await gradeRubric(rubric({ combine: "all" }, "clarity", "accuracy"), "out", judge);

  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((c) => c.dimension).sort(), ["accuracy", "clarity"]);
  for (const call of calls) {
    assert.equal(call.output, "out");
    assert.equal(call.criterion, `${call.dimension} criterion`);
  }
});

test("combine all passes only when every dimension passes", async () => {
  const allPass = judgeReturning({
    clarity: { pass: true, evidence: "a" },
    accuracy: { pass: true, evidence: "b" },
  });
  const r = rubric({ combine: "all" }, "clarity", "accuracy");
  assert.equal((await gradeRubric(r, "o", allPass.judge)).pass, true);

  const oneFails = judgeReturning({
    clarity: { pass: true, evidence: "a" },
    accuracy: { pass: false, evidence: "b" },
  });
  assert.equal((await gradeRubric(r, "o", oneFails.judge)).pass, false);
});

test("an abstain verdict never counts as a pass under combine all", async () => {
  const { judge } = judgeReturning({
    clarity: { pass: true, evidence: "a" },
    accuracy: { pass: "unknown", evidence: "cannot tell" },
  });
  const result = await gradeRubric(rubric({ combine: "all" }, "clarity", "accuracy"), "o", judge);
  assert.equal(result.pass, false);
  const abstained = result.dimensions.find((d) => d.dimension === "accuracy");
  assert.equal(abstained!.verdict.pass, "unknown");
});

test("combine fraction passes when the pass ratio meets the threshold", async () => {
  const { judge } = judgeReturning({
    a: { pass: true, evidence: "" },
    b: { pass: true, evidence: "" },
    c: { pass: false, evidence: "" },
  });
  const r = rubric({ combine: "fraction", threshold: 0.5 }, "a", "b", "c");
  assert.equal((await gradeRubric(r, "o", judge)).pass, true);
});

test("combine fraction fails below the threshold and counts abstain in the denominator", async () => {
  const { judge } = judgeReturning({
    a: { pass: true, evidence: "" },
    b: { pass: "unknown", evidence: "" },
    c: { pass: false, evidence: "" },
  });
  const r = rubric({ combine: "fraction", threshold: 0.5 }, "a", "b", "c");
  assert.equal((await gradeRubric(r, "o", judge)).pass, false);
});
