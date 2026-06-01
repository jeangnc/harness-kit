import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { lint } from "./lint.js";
import { makeFakeVendor } from "./vendor/fakeVendor.testutil.js";
import type { Vendor } from "./vendor/schema.js";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));

const claudeVendor = makeFakeVendor("claude");
const vendors: readonly Vendor[] = [claudeVendor];

interface Sandbox {
  readonly outRoot: string;
  readonly writeMd: (this: void, relativePath: string, body: string) => void;
}

async function withSandbox<T>(fn: (sandbox: Sandbox) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(repoRoot, ".test-tmp-lint-"));
  const outRoot = join(root, "dist");
  mkdirSync(outRoot, { recursive: true });
  const sandbox: Sandbox = {
    outRoot,
    writeMd: (relativePath, body) => {
      const full = join(outRoot, relativePath);
      mkdirSync(join(full, ".."), { recursive: true });
      writeFileSync(full, body);
    },
  };
  return fn(sandbox).finally(() => rmSync(root, { recursive: true, force: true }));
}

test("lint passes on clean markdown", async () => {
  await withSandbox(async ({ outRoot, writeMd }) => {
    writeMd(
      "claude/foo/skills/bar/SKILL.md",
      "---\nname: bar\ndescription: ok\n---\n\n# Bar\n\nClean body.\n",
    );
    const result = await lint({ outRoot, vendors, silent: true });
    assert.equal(result.errorCount, 0);
  });
});

test("lint flags markdown rule violations", async () => {
  await withSandbox(async ({ outRoot, writeMd }) => {
    writeMd(
      "claude/foo/skills/bar/SKILL.md",
      "---\nname: bar\ndescription: bad\n---\n\n# Heading\n## Skipped a level (MD001)\n",
    );
    const result = await lint({ outRoot, vendors, silent: true });
    assert.ok(result.errorCount > 0, "expected lint to report violations");
  });
});

test("lint default config disables line-length (MD013)", async () => {
  await withSandbox(async ({ outRoot, writeMd }) => {
    const longLine = "x".repeat(500);
    writeMd(
      "claude/foo/skills/bar/SKILL.md",
      `---\nname: bar\ndescription: long\n---\n\n# Bar\n\n${longLine}\n`,
    );
    const result = await lint({ outRoot, vendors, silent: true });
    assert.equal(result.errorCount, 0, "MD013 should be disabled by default");
  });
});

test("lint default config tolerates inline HTML (MD033)", async () => {
  await withSandbox(async ({ outRoot, writeMd }) => {
    writeMd(
      "claude/foo/skills/bar/SKILL.md",
      "---\nname: bar\ndescription: html\n---\n\n# Bar\n\n<div>inline</div>\n",
    );
    const result = await lint({ outRoot, vendors, silent: true });
    assert.equal(result.errorCount, 0, "MD033 should be disabled by default");
  });
});

test("lint default config allows duplicate sibling headings across files (MD024)", async () => {
  await withSandbox(async ({ outRoot, writeMd }) => {
    writeMd(
      "claude/foo/skills/a/SKILL.md",
      "---\nname: a\ndescription: x\n---\n\n# Title\n\n## Notes\n",
    );
    writeMd(
      "claude/foo/skills/b/SKILL.md",
      "---\nname: b\ndescription: x\n---\n\n# Title\n\n## Notes\n",
    );
    const result = await lint({ outRoot, vendors, silent: true });
    assert.equal(result.errorCount, 0);
  });
});

test("lint succeeds when there are no markdown files", async () => {
  await withSandbox(async ({ outRoot }) => {
    const result = await lint({ outRoot, vendors, silent: true });
    assert.equal(result.errorCount, 0);
  });
});
