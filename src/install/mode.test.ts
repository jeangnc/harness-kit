import { test } from "node:test";
import assert from "node:assert/strict";

import { INSTALL_MODES, isInstallMode, parseInstallMode } from "./mode.js";

test("parseInstallMode accepts remote", () => {
  assert.equal(parseInstallMode("remote"), "remote");
});

test("parseInstallMode accepts local", () => {
  assert.equal(parseInstallMode("local"), "local");
});

test("parseInstallMode rejects unknown values with the valid modes listed", () => {
  assert.throws(
    () => parseInstallMode("bogus"),
    /Unknown install mode "bogus"\. Valid: remote, local/,
  );
});

test("INSTALL_MODES lists remote and local", () => {
  assert.deepEqual([...INSTALL_MODES], ["remote", "local"]);
});

test("isInstallMode is true for a known mode", () => {
  assert.equal(isInstallMode("local"), true);
});

test("isInstallMode is false for an unknown mode", () => {
  assert.equal(isInstallMode("bogus"), false);
});
