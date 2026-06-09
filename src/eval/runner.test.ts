import { test } from "node:test";
import { strict as assert } from "node:assert";

import { buildArgs } from "./runner.js";

test("buildArgs runs the session in bypassPermissions so it writes files regardless of the launcher's mode", () => {
  const args = buildArgs("write email.ts", {});
  const flag = args.indexOf("--permission-mode");
  assert.notEqual(flag, -1, "expected --permission-mode to be passed");
  assert.equal(args[flag + 1], "bypassPermissions");
});

test("buildArgs passes the prompt non-interactively via -p", () => {
  const args = buildArgs("write email.ts", {});
  const p = args.indexOf("-p");
  assert.notEqual(p, -1);
  assert.equal(args[p + 1], "write email.ts");
});

test("buildArgs appends the model only when one is given", () => {
  assert.equal(buildArgs("x", {}).includes("--model"), false);
  const withModel = buildArgs("x", { model: "claude-haiku-4-5" });
  const m = withModel.indexOf("--model");
  assert.notEqual(m, -1);
  assert.equal(withModel[m + 1], "claude-haiku-4-5");
});

function settingsFrom(args: readonly string[]): unknown {
  const i = args.indexOf("--settings");
  assert.notEqual(i, -1, "expected --settings to be passed");
  return JSON.parse(args[i + 1]!);
}

test("buildArgs enables the given plugins via a merged --settings payload", () => {
  const args = buildArgs("x", { enabledPlugins: new Set(["dev-tools@jeangnc-marketplace"]) });
  assert.deepEqual(settingsFrom(args), {
    enabledPlugins: { "dev-tools@jeangnc-marketplace": true },
  });
});

test("buildArgs enables every plugin in the set", () => {
  const args = buildArgs("x", {
    enabledPlugins: new Set(["a@m", "b@m"]),
  });
  assert.deepEqual(settingsFrom(args), {
    enabledPlugins: { "a@m": true, "b@m": true },
  });
});

test("buildArgs omits --settings when no plugins are requested", () => {
  assert.equal(buildArgs("x", {}).includes("--settings"), false);
  assert.equal(buildArgs("x", { enabledPlugins: new Set() }).includes("--settings"), false);
});
