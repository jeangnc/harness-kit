import { test } from "node:test";
import assert from "node:assert/strict";

import { builtinVendors } from "./builtins.js";

test("builtinVendors ships claude and codex by default", () => {
  const names = builtinVendors()
    .map((v) => v.name)
    .sort();
  assert.deepEqual(names, ["claude", "codex"]);
});
