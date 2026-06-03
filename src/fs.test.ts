import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readdirOrEmpty } from "./fs.js";

test("readdirOrEmpty returns directory entries", async () => {
  const dir = mkdtempSync(join(tmpdir(), "harness-kit-readdir-"));
  try {
    writeFileSync(join(dir, "a.txt"), "");
    assert.deepEqual(await readdirOrEmpty(dir), ["a.txt"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readdirOrEmpty returns an empty array when the directory is absent", async () => {
  assert.deepEqual(await readdirOrEmpty(join(tmpdir(), "harness-kit-no-such-dir-xyz")), []);
});

test("readdirOrEmpty rethrows when the path is not a directory", async () => {
  const dir = mkdtempSync(join(tmpdir(), "harness-kit-readdir-"));
  const file = join(dir, "file.txt");
  try {
    writeFileSync(file, "");
    await assert.rejects(readdirOrEmpty(file), /ENOTDIR/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
