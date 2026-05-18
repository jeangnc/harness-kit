import { test } from "node:test";
import { strict as assert } from "node:assert";

import { offsetToLineCol } from "./source-position.js";

test("offsetToLineCol returns line 1 col 1 for offset 0", () => {
  assert.deepEqual(offsetToLineCol("hello\nworld\n", 0), { line: 1, column: 1 });
});

test("offsetToLineCol returns the column on the same line", () => {
  assert.deepEqual(offsetToLineCol("hello world", 6), { line: 1, column: 7 });
});

test("offsetToLineCol returns line 2 col 1 immediately after a newline", () => {
  assert.deepEqual(offsetToLineCol("ab\ncd", 3), { line: 2, column: 1 });
});

test("offsetToLineCol counts lines on a multi-line input", () => {
  const text = "one\ntwo\nthree";
  assert.deepEqual(offsetToLineCol(text, text.indexOf("three")), { line: 3, column: 1 });
});

test("offsetToLineCol clamps offsets past the end to the final position", () => {
  assert.deepEqual(offsetToLineCol("abc\n", 100), { line: 2, column: 1 });
});

test("offsetToLineCol handles a string with no newlines", () => {
  assert.deepEqual(offsetToLineCol("abcdef", 4), { line: 1, column: 5 });
});
