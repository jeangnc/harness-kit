import { test } from "node:test";
import { strict as assert } from "node:assert";

import { CaseFileSchema, caseExpectedSkills, type EvalCase } from "./schema.js";

function routingFile(cases: unknown[]): unknown {
  return { suite: "s", tier: "routing", cases };
}

function solvingFile(cases: unknown[]): unknown {
  return { suite: "s", tier: "solving", cases };
}

test("routing file accepts a case with an expect clause", () => {
  const result = CaseFileSchema.safeParse(
    routingFile([{ id: "r1", prompt: "p", expect: { first: "alpha:plan" } }]),
  );
  assert.equal(result.success, true);
});

test("routing file rejects a case carrying solving assert keys", () => {
  const result = CaseFileSchema.safeParse(
    routingFile([{ id: "r1", prompt: "p", expect: { first: "alpha:plan" }, assert: [] }]),
  );
  assert.equal(result.success, false);
});

test("routing file rejects a case carrying a rubric key", () => {
  const result = CaseFileSchema.safeParse(
    routingFile([
      { id: "r1", prompt: "p", expect: { first: "alpha:plan" }, rubric: { dimensions: [] } },
    ]),
  );
  assert.equal(result.success, false);
});

test("solving file accepts assertions and a rubric", () => {
  const result = CaseFileSchema.safeParse(
    solvingFile([
      {
        id: "s1",
        prompt: "p",
        assert: [{ kind: "outputMatches", pattern: "ok" }],
        rubric: {
          dimensions: [{ dimension: "clarity", criterion: "reads clearly" }],
          combine: { combine: "all" },
        },
      },
    ]),
  );
  assert.equal(result.success, true);
});

test("solving file rejects a case carrying a routing expect clause", () => {
  const result = CaseFileSchema.safeParse(
    solvingFile([{ id: "s1", prompt: "p", expect: { first: "alpha:plan" } }]),
  );
  assert.equal(result.success, false);
});

test("solving assert accepts every assertion kind", () => {
  const result = CaseFileSchema.safeParse(
    solvingFile([
      {
        id: "s1",
        prompt: "p",
        assert: [
          { kind: "outputMatches", pattern: "yes" },
          { kind: "outputExcludes", pattern: "no" },
          { kind: "usedTool", tool: "Write" },
          { kind: "didNotUseTool", tool: "Bash" },
          { kind: "wroteFile", path: "out.txt" },
        ],
      },
    ]),
  );
  assert.equal(result.success, true);
});

test("solving assert rejects an unknown assertion kind", () => {
  const result = CaseFileSchema.safeParse(
    solvingFile([{ id: "s1", prompt: "p", assert: [{ kind: "magic", pattern: "x" }] }]),
  );
  assert.equal(result.success, false);
});

test("solving wroteFile assertion requires a path", () => {
  const result = CaseFileSchema.safeParse(
    solvingFile([{ id: "s1", prompt: "p", assert: [{ kind: "wroteFile" }] }]),
  );
  assert.equal(result.success, false);
});

test("solving expectSkill accepts a fully-qualified id and rejects a bare name", () => {
  const ok = CaseFileSchema.safeParse(
    solvingFile([{ id: "s1", prompt: "p", expectSkill: "alpha:plan" }]),
  );
  assert.equal(ok.success, true);

  const bad = CaseFileSchema.safeParse(
    solvingFile([{ id: "s1", prompt: "p", expectSkill: "plan" }]),
  );
  assert.equal(bad.success, false);
});

test("solving rubric fraction combine requires a threshold", () => {
  const ok = CaseFileSchema.safeParse(
    solvingFile([
      {
        id: "s1",
        prompt: "p",
        rubric: {
          dimensions: [{ dimension: "d", criterion: "c" }],
          combine: { combine: "fraction", threshold: 0.5 },
        },
      },
    ]),
  );
  assert.equal(ok.success, true);

  const bad = CaseFileSchema.safeParse(
    solvingFile([
      {
        id: "s1",
        prompt: "p",
        rubric: {
          dimensions: [{ dimension: "d", criterion: "c" }],
          combine: { combine: "fraction" },
        },
      },
    ]),
  );
  assert.equal(bad.success, false);
});

test("caseExpectedSkills returns routing expectation skills", () => {
  const routing: EvalCase = { id: "r1", prompt: "p", expect: { first: "alpha:plan" } };
  assert.deepEqual(caseExpectedSkills(routing), ["alpha:plan"]);
});

test("caseExpectedSkills returns the solving expectSkill when present, else empty", () => {
  const pinned: EvalCase = { id: "s1", prompt: "p", assert: [], expectSkill: "alpha:plan" };
  assert.deepEqual(caseExpectedSkills(pinned), ["alpha:plan"]);

  const bare: EvalCase = { id: "s2", prompt: "p", assert: [] };
  assert.deepEqual(caseExpectedSkills(bare), []);
});
