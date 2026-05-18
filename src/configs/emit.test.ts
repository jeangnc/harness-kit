import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { emitConfigsManifest } from "./emit.js";

async function withSandbox(fn: (root: string) => Promise<void> | void): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "harness-configs-emit-"));
  try {
    await fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("emitConfigsManifest writes dist/configs.json with the manifest", async () => {
  await withSandbox(async (root) => {
    const srcRoot = join(root, "src");
    const outRoot = join(root, "dist");
    mkdirSync(join(srcRoot, "configs", "common"), { recursive: true });
    writeFileSync(join(srcRoot, "configs", "common", "AGENTS.md"), "");
    await emitConfigsManifest({ srcRoot, outRoot, vendors: ["claude"] });
    const target = join(outRoot, "configs.json");
    assert.equal(existsSync(target), true);
    const parsed = JSON.parse(readFileSync(target, "utf8")) as { links: unknown[] };
    assert.deepEqual(parsed, {
      links: [
        {
          src: "configs/common/AGENTS.md",
          vendors: ["claude"],
          destRel: "AGENTS.md",
          kind: "file",
        },
      ],
    });
  });
});

test("emitConfigsManifest writes empty manifest when src/configs is absent", async () => {
  await withSandbox(async (root) => {
    const srcRoot = join(root, "src");
    const outRoot = join(root, "dist");
    mkdirSync(srcRoot, { recursive: true });
    await emitConfigsManifest({ srcRoot, outRoot, vendors: ["claude"] });
    const parsed = JSON.parse(readFileSync(join(outRoot, "configs.json"), "utf8")) as unknown;
    assert.deepEqual(parsed, { links: [] });
  });
});
