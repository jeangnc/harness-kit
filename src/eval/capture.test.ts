import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { captureRun, withDiskWrites } from "./capture.js";

test("captureRun keeps every tool call in the trajectory", () => {
  const trajectory = [
    { name: "Read", input: {} },
    { name: "Write", input: { file_path: "a.txt", content: "x" } },
  ];
  assert.deepEqual(captureRun("out", trajectory).trajectory, trajectory);
});

test("captureRun collects a Write file path and content", () => {
  const capture = captureRun("", [{ name: "Write", input: { file_path: "a.txt", content: "x" } }]);
  assert.deepEqual(capture.writes, [{ path: "a.txt", content: "x" }]);
});

test("captureRun collects an Edit file path with new_string as content", () => {
  const capture = captureRun("", [
    { name: "Edit", input: { file_path: "a.txt", old_string: "o", new_string: "n" } },
  ]);
  assert.deepEqual(capture.writes, [{ path: "a.txt", content: "n" }]);
});

test("captureRun ignores non-write tools in writes", () => {
  assert.deepEqual(captureRun("", [{ name: "Bash", input: { file_path: "a.txt" } }]).writes, []);
});

test("withDiskWrites records a declared file read from disk under the cwd", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "capture-"));
  await writeFile(join(cwd, "out.txt"), "from a heredoc");
  const capture = await withDiskWrites(captureRun("", []), cwd, ["out.txt"]);
  assert.deepEqual(capture.writes, [{ path: "out.txt", content: "from a heredoc" }]);
});

test("withDiskWrites leaves writes unchanged when the declared file is absent", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "capture-"));
  const capture = await withDiskWrites(captureRun("", []), cwd, ["missing.txt"]);
  assert.deepEqual(capture.writes, []);
});
