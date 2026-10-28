import { test } from "node:test";
import { strict as assert } from "node:assert";

import { trajectoryOf } from "./trajectory.js";

test("trajectoryOf reads tool calls in order from response metadata", () => {
  const metadata = {
    toolCalls: [
      { name: "Read", input: { file_path: "a" }, id: "1" },
      { name: "Skill", input: { skill: "alpha:plan" }, id: "2" },
    ],
  };
  assert.deepEqual(trajectoryOf(metadata), [
    { name: "Read", input: { file_path: "a" } },
    { name: "Skill", input: { skill: "alpha:plan" } },
  ]);
});

test("trajectoryOf returns no calls when metadata is missing", () => {
  assert.deepEqual(trajectoryOf(undefined), []);
});

test("trajectoryOf skips entries without a tool name", () => {
  assert.deepEqual(trajectoryOf({ toolCalls: [{ input: {} }, "junk"] }), []);
});
