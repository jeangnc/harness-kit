import { test } from "node:test";
import { strict as assert } from "node:assert";

import { commaSeparated, parsePositiveInt, parseTier } from "./parse.js";

test("commaSeparated, given undefined, returns nothing", () => {
  assert.deepEqual(commaSeparated(undefined), []);
});

test("commaSeparated, given an empty string, returns nothing", () => {
  assert.deepEqual(commaSeparated(""), []);
});

test("commaSeparated trims surrounding whitespace from each entry", () => {
  assert.deepEqual(commaSeparated(" docs , README.md "), ["docs", "README.md"]);
});

test("commaSeparated drops empty entries left by stray commas", () => {
  assert.deepEqual(commaSeparated("docs,,README.md,"), ["docs", "README.md"]);
});

test("parseTier, given a known tier, returns it", () => {
  assert.equal(parseTier("routing"), "routing");
});

test("parseTier, given an unknown tier, throws naming the valid ones", () => {
  assert.throws(() => parseTier("nonsense"), /Unknown tier "nonsense"\. Valid: /);
});

test("parsePositiveInt, given a positive integer, returns it", () => {
  assert.equal(parsePositiveInt("3", "runs"), 3);
});

test("parsePositiveInt, given zero, throws naming the flag", () => {
  assert.throws(() => parsePositiveInt("0", "runs"), /--runs must be a positive integer/);
});

test("parsePositiveInt, given a non-integer, throws naming the flag", () => {
  assert.throws(() => parsePositiveInt("1.5", "concurrency"), /--concurrency must be a positive/);
});
