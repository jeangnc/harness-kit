import { test } from "node:test";
import { strict as assert } from "node:assert";

import { unresolvedSkills, type LoadedRoutingCase, type LoadedSolvingCase } from "./cases.js";

function routing(expect: LoadedRoutingCase["expect"]): LoadedRoutingCase {
  return { id: "r1", prompt: "p", expect, suite: "s", tier: "routing", file: "f.yaml" };
}

function solving(partial: Partial<LoadedSolvingCase>): LoadedSolvingCase {
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

test("unresolvedSkills flags a routing expectation skill that is not installed", () => {
  const errors = unresolvedSkills([routing({ first: "alpha:plan" })], new Set());
  assert.equal(errors.length, 1);
  assert.match(errors[0]!.message, /alpha:plan/);
});

test("unresolvedSkills flags a solving expectSkill that is not installed", () => {
  const errors = unresolvedSkills([solving({ expectSkill: "alpha:plan" })], new Set());
  assert.equal(errors.length, 1);
  assert.match(errors[0]!.message, /alpha:plan/);
});

test("unresolvedSkills passes a solving case with no pinned skill", () => {
  assert.deepEqual(unresolvedSkills([solving({})], new Set()), []);
});

test("unresolvedSkills passes when the pinned skill is installed", () => {
  assert.deepEqual(
    unresolvedSkills([solving({ expectSkill: "alpha:plan" })], new Set(["alpha:plan"])),
    [],
  );
});
