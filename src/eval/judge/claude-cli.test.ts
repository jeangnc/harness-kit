import { test } from "node:test";
import { strict as assert } from "node:assert";

import { judgeArgs } from "./claude-cli.js";

test("judgeArgs runs a one-shot json prompt pinned to the given model", () => {
  const args = judgeArgs("grade this", "claude-haiku-4-5", '{"type":"object"}');

  assert.deepEqual(args.slice(0, 3), ["-p", "grade this", "--output-format"]);
  assert.equal(args[3], "json");
  assert.equal(args[args.indexOf("--model") + 1], "claude-haiku-4-5");
  assert.equal(args[args.indexOf("--json-schema") + 1], '{"type":"object"}');
});

test("judgeArgs pins a deterministic permission mode so the judge is unaffected by the launcher's mode", () => {
  const args = judgeArgs("grade this", "claude-haiku-4-5", '{"type":"object"}');
  const flag = args.indexOf("--permission-mode");
  assert.notEqual(flag, -1, "expected --permission-mode to be passed");
  assert.equal(args[flag + 1], "bypassPermissions");
});
