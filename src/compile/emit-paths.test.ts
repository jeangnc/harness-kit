import { test } from "node:test";
import { strict as assert } from "node:assert";

import { unemittedSegment } from "./emit-paths.js";

test("unemittedSegment, for a path with a dot-prefixed segment, names that segment", () => {
  assert.equal(unemittedSegment(".fragments/foo.md"), ".fragments");
});

test("unemittedSegment, for a dot-prefixed segment nested deeper in the path, names that segment", () => {
  assert.equal(unemittedSegment("shared/.internal/foo.md"), ".internal");
});

test("unemittedSegment, for a relative-nav path into a dot-dir, names the dot-dir", () => {
  assert.equal(unemittedSegment("./.fragments/foo.md"), ".fragments");
});

test("unemittedSegment, for a passthrough dotfile, returns undefined", () => {
  assert.equal(unemittedSegment(".mcp.json"), undefined);
});

test("unemittedSegment, for a clean path, returns undefined", () => {
  assert.equal(unemittedSegment("shared/x.md"), undefined);
});

test("unemittedSegment, for relative-nav segments only, returns undefined", () => {
  assert.equal(unemittedSegment("./shared/x.md"), undefined);
  assert.equal(unemittedSegment("../../principles.md"), undefined);
});
