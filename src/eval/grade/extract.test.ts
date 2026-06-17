import { test } from "node:test";
import { strict as assert } from "node:assert";

import { extractAnswer } from "./extract.js";

const delimiter = { start: "===REVIEW===", end: "===" };

test("extractAnswer, with no delimiter, returns the raw output", () => {
  const raw = "preamble\n===REVIEW===\nbody\n===";
  assert.deepEqual(extractAnswer(undefined, raw), { found: true, text: raw });
});

test("extractAnswer, when the start marker is absent, reports no block found", () => {
  assert.deepEqual(extractAnswer(delimiter, "just narration, no block"), { found: false });
});

test("extractAnswer drops the preamble and returns the block including its markers", () => {
  const raw = "Here is my review:\n===REVIEW===\nbody\n===";
  assert.deepEqual(extractAnswer(delimiter, raw), {
    found: true,
    text: "===REVIEW===\nbody\n===",
  });
});

test("extractAnswer, when no closing marker follows the start, returns from start to end", () => {
  const raw = "prose\n===REVIEW===\nbody with no close";
  assert.deepEqual(extractAnswer(delimiter, raw), {
    found: true,
    text: "===REVIEW===\nbody with no close",
  });
});

test("extractAnswer uses the first start and the first end after it", () => {
  const raw = "===REVIEW===\nfirst\n===\nmiddle\n===REVIEW===\nsecond\n===";
  assert.deepEqual(extractAnswer(delimiter, raw), {
    found: true,
    text: "===REVIEW===\nfirst\n===",
  });
});

test("extractAnswer ignores an end marker that appears before the start", () => {
  const raw = "===\nstray close\n===REVIEW===\nbody\n===";
  assert.deepEqual(extractAnswer(delimiter, raw), {
    found: true,
    text: "===REVIEW===\nbody\n===",
  });
});

test("extractAnswer, with identical start and end markers, closes at the next occurrence", () => {
  const raw = "a\n===\nbody\n===\ntrailer";
  assert.deepEqual(extractAnswer({ start: "===", end: "===" }, raw), {
    found: true,
    text: "===\nbody\n===",
  });
});
