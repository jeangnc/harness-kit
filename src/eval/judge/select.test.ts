import { test } from "node:test";
import { strict as assert } from "node:assert";

import { selectJudge, DEFAULT_JUDGE_MODEL } from "./select.js";

test("defaults to the subagent judge so no API key is required", () => {
  const judge = selectJudge({ model: DEFAULT_JUDGE_MODEL });

  assert.equal(typeof judge, "function");
});

test("defaults the judge model to a cheap tier", () => {
  assert.match(DEFAULT_JUDGE_MODEL, /haiku/);
});

test("uses an explicitly provided judge verbatim", () => {
  const provided = async () => ({ pass: true as const, evidence: "x" });

  const judge = selectJudge({ model: DEFAULT_JUDGE_MODEL, override: provided });

  assert.equal(judge, provided);
});
