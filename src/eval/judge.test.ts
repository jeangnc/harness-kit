import { test } from "node:test";
import { strict as assert } from "node:assert";

import { Verdict, parseVerdict } from "./judge.js";

test("Verdict accepts a boolean pass with evidence", () => {
  assert.equal(Verdict.safeParse({ pass: true, evidence: "clear" }).success, true);
  assert.equal(Verdict.safeParse({ pass: false, evidence: "muddled" }).success, true);
});

test("Verdict accepts the unknown abstain value", () => {
  assert.equal(Verdict.safeParse({ pass: "unknown", evidence: "cannot tell" }).success, true);
});

test("Verdict rejects an arbitrary pass string", () => {
  assert.equal(Verdict.safeParse({ pass: "maybe", evidence: "x" }).success, false);
});

test("parseVerdict abstains on an unparseable verdict", () => {
  const verdict = parseVerdict({ pass: "nonsense" });
  assert.equal(verdict.pass, "unknown");
  assert.match(verdict.evidence, /unparseable|abstain/i);
});

test("parseVerdict returns the parsed verdict on a valid shape", () => {
  const verdict = parseVerdict({ pass: true, evidence: "meets the bar" });
  assert.equal(verdict.pass, true);
  assert.equal(verdict.evidence, "meets the bar");
});
