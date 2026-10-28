import { test } from "node:test";
import { strict as assert } from "node:assert";

import { detectSkills } from "./detect.js";

test("detectSkills records skill invocations in call order", () => {
  const result = detectSkills([
    { name: "Skill", input: { skill: "alpha:plan" } },
    { name: "Skill", input: { skill: "beta:check" } },
  ]);
  assert.deepEqual(result, { observed: ["alpha:plan", "beta:check"], firstSkill: "alpha:plan" });
});

test("detectSkills ignores non-Skill tools", () => {
  const result = detectSkills([
    { name: "Read", input: { skill: "alpha:plan" } },
    { name: "Skill", input: { skill: "beta:check" } },
  ]);
  assert.equal(result.firstSkill, "beta:check");
});

test("detectSkills reports no skill when none fired", () => {
  assert.deepEqual(detectSkills([{ name: "Bash", input: {} }]), { observed: [], firstSkill: null });
});

test("detectSkills reads the command key when the Skill input names a command", () => {
  assert.equal(
    detectSkills([{ name: "Skill", input: { command: "alpha:ship" } }]).firstSkill,
    "alpha:ship",
  );
});

test("detectSkills ignores a Skill input that is not a plugin:name id", () => {
  assert.equal(detectSkills([{ name: "Skill", input: { skill: "plan" } }]).firstSkill, null);
});
