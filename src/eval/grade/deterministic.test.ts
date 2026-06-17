import { test } from "node:test";
import { strict as assert } from "node:assert";

import type { SolvingCapture } from "../capture.js";
import { gradeAssertions } from "./deterministic.js";
import type { Assertion } from "../schema.js";

function capture(partial: Partial<SolvingCapture>): SolvingCapture {
  return {
    outputText: "",
    trajectory: [],
    writes: [],
    exitReason: "result",
    ...partial,
  };
}

function gradeOne(assertion: Assertion, partial: Partial<SolvingCapture>) {
  const cap = capture(partial);
  const [result] = gradeAssertions([assertion], cap, cap.outputText);
  return result!;
}

test("outputMatches passes on a substring and fails with evidence otherwise", () => {
  const a: Assertion = { kind: "outputMatches", pattern: "world", regex: false };
  assert.equal(gradeOne(a, { outputText: "hello world" }).pass, true);
  const miss = gradeOne(a, { outputText: "hello there" });
  assert.equal(miss.pass, false);
  assert.match(miss.evidence, /no match/i);
});

test("outputMatches honors regex mode", () => {
  const a: Assertion = { kind: "outputMatches", pattern: "h\\d+", regex: true };
  assert.equal(gradeOne(a, { outputText: "h42 ok" }).pass, true);
  assert.equal(gradeOne(a, { outputText: "hh ok" }).pass, false);
});

test("outputExcludes passes when absent and fails citing the offending match", () => {
  const a: Assertion = { kind: "outputExcludes", pattern: "error", regex: false };
  assert.equal(gradeOne(a, { outputText: "all good" }).pass, true);
  const hit = gradeOne(a, { outputText: "an error occurred" });
  assert.equal(hit.pass, false);
  assert.match(hit.evidence, /error/);
});

test("outputMatches grades the provided answer surface, not the raw capture text", () => {
  const a: Assertion = { kind: "outputMatches", pattern: "VERDICT", regex: false };
  const cap = capture({ outputText: "preamble narration only" });
  const [result] = gradeAssertions([a], cap, "===REVIEW===\nVERDICT\n===");
  assert.equal(result!.pass, true);
});

test("outputExcludes grades the raw capture text, not the answer surface", () => {
  const a: Assertion = { kind: "outputExcludes", pattern: "Here is my review", regex: false };
  const cap = capture({ outputText: "Here is my review:\n===REVIEW===\nclean\n===" });
  const [result] = gradeAssertions([a], cap, "===REVIEW===\nclean\n===");
  assert.equal(result!.pass, false);
  assert.match(result!.evidence, /Here is my review/);
});

test("usedTool passes when the tool appears and fails listing observed tools", () => {
  const a: Assertion = { kind: "usedTool", tool: "Write" };
  assert.equal(gradeOne(a, { trajectory: [{ name: "Write", input: {} }] }).pass, true);
  const miss = gradeOne(a, { trajectory: [{ name: "Read", input: {} }] });
  assert.equal(miss.pass, false);
  assert.match(miss.evidence, /Read/);
});

test("didNotUseTool passes when absent and fails when the tool was used", () => {
  const a: Assertion = { kind: "didNotUseTool", tool: "Bash" };
  assert.equal(gradeOne(a, { trajectory: [{ name: "Read", input: {} }] }).pass, true);
  const hit = gradeOne(a, { trajectory: [{ name: "Bash", input: {} }] });
  assert.equal(hit.pass, false);
  assert.match(hit.evidence, /Bash/);
});

function wrote(path: string): { name: string; input: unknown } {
  return { name: "Write", input: { file_path: path } };
}

test("wroteFile passes when the agent wrote the path and fails when it did not", () => {
  const a: Assertion = { kind: "wroteFile", path: "out.txt", regex: false };
  assert.equal(
    gradeOne(a, { trajectory: [wrote("out.txt")], writes: [{ path: "out.txt", content: "x" }] })
      .pass,
    true,
  );
  const miss = gradeOne(a, { trajectory: [wrote("other.txt")] });
  assert.equal(miss.pass, false);
  assert.match(miss.evidence, /out\.txt/);
});

test("wroteFile counts a disk-merged write absent from the tool trajectory", () => {
  const a: Assertion = { kind: "wroteFile", path: "out.txt", regex: false };
  const result = gradeOne(a, {
    trajectory: [],
    writes: [{ path: "out.txt", content: "from a heredoc" }],
  });
  assert.equal(result.pass, true);
});

test("wroteFile fails when nothing was written to the declared path", () => {
  const a: Assertion = { kind: "wroteFile", path: "out.txt", regex: false };
  const result = gradeOne(a, { trajectory: [wrote("other.txt")], writes: [] });
  assert.equal(result.pass, false);
  assert.match(result.evidence, /out\.txt/);
});

test("wroteFile matches a declared relative path when the agent wrote an absolute file_path", () => {
  const a: Assertion = { kind: "wroteFile", path: "app/models/order.rb", regex: false };
  const result = gradeOne(a, {
    trajectory: [wrote("/abs/sandbox/app/models/order.rb")],
    writes: [{ path: "app/models/order.rb", content: "class Order; end" }],
  });
  assert.equal(result.pass, true);
});

test("wroteFile with contentMatches passes on matching content and fails on mismatch", () => {
  const a: Assertion = {
    kind: "wroteFile",
    path: "out.txt",
    contentMatches: "hello",
    regex: false,
  };
  assert.equal(
    gradeOne(a, {
      trajectory: [wrote("out.txt")],
      writes: [{ path: "out.txt", content: "hello world" }],
    }).pass,
    true,
  );
  const mismatch = gradeOne(a, {
    trajectory: [wrote("out.txt")],
    writes: [{ path: "out.txt", content: "goodbye" }],
  });
  assert.equal(mismatch.pass, false);
  assert.match(mismatch.evidence, /content/i);
});

test("a malformed regex assertion fails with evidence instead of throwing", () => {
  const a: Assertion = { kind: "outputMatches", pattern: "[unterminated", regex: true };
  const result = gradeOne(a, { outputText: "anything" });
  assert.equal(result.pass, false);
  assert.match(result.evidence, /invalid regex/i);
});

test("gradeAssertions returns one result per assertion preserving order", () => {
  const results = gradeAssertions(
    [
      { kind: "usedTool", tool: "Write" },
      { kind: "didNotUseTool", tool: "Bash" },
    ],
    capture({ trajectory: [{ name: "Write", input: {} }] }),
    "",
  );
  assert.equal(results.length, 2);
  assert.equal(results[0]!.assertion.kind, "usedTool");
  assert.equal(results[1]!.assertion.kind, "didNotUseTool");
});
