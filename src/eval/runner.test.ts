import { test } from "node:test";
import { strict as assert } from "node:assert";

import { buildArgs } from "./runner.js";

test("buildArgs runs the session in bypassPermissions so it writes files regardless of the launcher's mode", () => {
  const args = buildArgs("write email.ts", undefined);
  const flag = args.indexOf("--permission-mode");
  assert.notEqual(flag, -1, "expected --permission-mode to be passed");
  assert.equal(args[flag + 1], "bypassPermissions");
});

test("buildArgs passes the prompt non-interactively via -p", () => {
  const args = buildArgs("write email.ts", undefined);
  const p = args.indexOf("-p");
  assert.notEqual(p, -1);
  assert.equal(args[p + 1], "write email.ts");
});

test("buildArgs appends the model only when one is given", () => {
  assert.equal(buildArgs("x", undefined).includes("--model"), false);
  const withModel = buildArgs("x", "claude-haiku-4-5");
  const m = withModel.indexOf("--model");
  assert.notEqual(m, -1);
  assert.equal(withModel[m + 1], "claude-haiku-4-5");
});
