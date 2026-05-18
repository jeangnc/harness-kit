import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  symlinkSync,
  lstatSync,
  readlinkSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applyLink } from "./applier.js";

async function withSandbox<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "harness-kit-link-test-"));
  try {
    return await fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("applyLink creates a fresh symlink when destination does not exist", async () => {
  await withSandbox(async (root) => {
    const src = join(root, "src.txt");
    const dest = join(root, "dest.txt");
    writeFileSync(src, "hello");

    await applyLink({ srcAbs: src, destAbs: dest });

    assert.ok(lstatSync(dest).isSymbolicLink());
    assert.equal(readlinkSync(dest), src);
    assert.equal(readFileSync(dest, "utf8"), "hello");
  });
});

test("applyLink replaces an existing symlink without backup", async () => {
  await withSandbox(async (root) => {
    const oldSrc = join(root, "old.txt");
    const newSrc = join(root, "new.txt");
    const dest = join(root, "dest.txt");
    writeFileSync(oldSrc, "old");
    writeFileSync(newSrc, "new");
    symlinkSync(oldSrc, dest);

    await applyLink({ srcAbs: newSrc, destAbs: dest });

    assert.ok(lstatSync(dest).isSymbolicLink());
    assert.equal(readlinkSync(dest), newSrc);
    assert.equal(readFileSync(dest, "utf8"), "new");
    assert.ok(!existsSync(`${dest}.backup`), "must not create backup for symlink replacement");
  });
});

test("applyLink backs up a non-symlink destination before linking", async () => {
  await withSandbox(async (root) => {
    const src = join(root, "src.txt");
    const dest = join(root, "dest.txt");
    writeFileSync(src, "from-src");
    writeFileSync(dest, "user-data");

    await applyLink({ srcAbs: src, destAbs: dest });

    assert.ok(lstatSync(dest).isSymbolicLink());
    assert.equal(readFileSync(dest, "utf8"), "from-src");
    assert.equal(readFileSync(`${dest}.backup`, "utf8"), "user-data");
  });
});

test("applyLink creates parent directories of destination as needed", async () => {
  await withSandbox(async (root) => {
    const src = join(root, "src.txt");
    const dest = join(root, "nested/deep/dest.txt");
    writeFileSync(src, "hi");

    await applyLink({ srcAbs: src, destAbs: dest });

    assert.ok(lstatSync(dest).isSymbolicLink());
    assert.equal(readFileSync(dest, "utf8"), "hi");
  });
});

test("applyLink links a directory as a directory", async () => {
  await withSandbox(async (root) => {
    const src = join(root, "src-dir");
    const dest = join(root, "dest-dir");
    mkdirSync(src);
    writeFileSync(join(src, "inside.txt"), "inside");

    await applyLink({ srcAbs: src, destAbs: dest });

    assert.ok(lstatSync(dest).isSymbolicLink());
    assert.equal(readFileSync(join(dest, "inside.txt"), "utf8"), "inside");
  });
});

test("applyLink backs up a non-symlink directory before linking", async () => {
  await withSandbox(async (root) => {
    const src = join(root, "src-dir");
    const dest = join(root, "dest-dir");
    mkdirSync(src);
    writeFileSync(join(src, "inside.txt"), "from-src");
    mkdirSync(dest);
    writeFileSync(join(dest, "user-file.txt"), "user-data");

    await applyLink({ srcAbs: src, destAbs: dest });

    assert.ok(lstatSync(dest).isSymbolicLink());
    assert.equal(readFileSync(join(dest, "inside.txt"), "utf8"), "from-src");
    assert.equal(readFileSync(join(`${dest}.backup`, "user-file.txt"), "utf8"), "user-data");
  });
});
