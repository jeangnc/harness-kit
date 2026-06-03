import { test } from "node:test";
import { strict as assert } from "node:assert";

import { createCaptor } from "./capture.js";

function assistant(...blocks: unknown[]): string {
  return JSON.stringify({ type: "assistant", message: { content: blocks } });
}

function toolUse(name: string, input: unknown): unknown {
  return { type: "tool_use", name, input };
}

function textBlock(text: string): unknown {
  return { type: "text", text };
}

function resultEvent(result: string): string {
  return JSON.stringify({ type: "result", result });
}

function capture(lines: string[]) {
  const captor = createCaptor();
  for (const line of lines) {
    captor.push(line);
    if (captor.done) break;
  }
  return captor.result("stream-end");
}

test("captor records tool calls in trajectory order", () => {
  const out = capture([
    assistant(toolUse("Read", { file_path: "a.ts" })),
    assistant(toolUse("Write", { file_path: "b.ts", content: "x" })),
    resultEvent("done"),
  ]);
  assert.deepEqual(
    out.trajectory.map((t) => t.name),
    ["Read", "Write"],
  );
});

test("captor collects Write file path and content", () => {
  const out = capture([
    assistant(toolUse("Write", { file_path: "out.txt", content: "hello" })),
    resultEvent("done"),
  ]);
  assert.deepEqual(out.writes, [{ path: "out.txt", content: "hello" }]);
});

test("captor collects Edit file path and new_string as content", () => {
  const out = capture([
    assistant(toolUse("Edit", { file_path: "out.txt", old_string: "a", new_string: "b" })),
    resultEvent("done"),
  ]);
  assert.deepEqual(out.writes, [{ path: "out.txt", content: "b" }]);
});

test("captor ignores non-write tools in writes but keeps them in trajectory", () => {
  const out = capture([assistant(toolUse("Bash", { command: "ls" })), resultEvent("done")]);
  assert.deepEqual(out.writes, []);
  assert.deepEqual(
    out.trajectory.map((t) => t.name),
    ["Bash"],
  );
});

test("captor takes output text from the result event", () => {
  const out = capture([assistant(textBlock("draft")), resultEvent("final answer")]);
  assert.equal(out.outputText, "final answer");
  assert.equal(out.exitReason, "result");
});

test("captor falls back to the last assistant text when the result text is empty", () => {
  const out = capture([
    assistant(textBlock("first")),
    assistant(textBlock("second")),
    resultEvent(""),
  ]);
  assert.equal(out.outputText, "second");
});

test("captor is not done until the result event arrives", () => {
  const captor = createCaptor();
  captor.push(assistant(toolUse("Read", { file_path: "a.ts" })));
  assert.equal(captor.done, false);
  captor.push(resultEvent("done"));
  assert.equal(captor.done, true);
});

test("captor ignores malformed JSON lines", () => {
  const out = capture([
    "not json",
    assistant(toolUse("Write", { file_path: "a", content: "b" })),
    resultEvent("ok"),
  ]);
  assert.deepEqual(out.writes, [{ path: "a", content: "b" }]);
  assert.equal(out.outputText, "ok");
});
