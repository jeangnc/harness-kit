import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import yaml from "js-yaml";

import { initHarness } from "./index.js";

async function withSandbox<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "harness-kit-init-"));
  try {
    return await fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("init writes harness.yaml with marketplace and vendors", async () => {
  await withSandbox(async (root) => {
    await initHarness({ repoRoot: root, marketplace: "shop", vendors: ["claude"], silent: true });
    const doc = yaml.load(readFileSync(join(root, "harness.yaml"), "utf8")) as {
      marketplace: string;
      vendors: string[];
    };
    assert.equal(doc.marketplace, "shop");
    assert.deepEqual(doc.vendors, ["claude"]);
  });
});

test("init scaffolds src/configs/<vendor>/.gitkeep for every vendor plus common", async () => {
  await withSandbox(async (root) => {
    await initHarness({
      repoRoot: root,
      marketplace: "shop",
      vendors: ["claude", "codex"],
      silent: true,
    });
    assert.ok(existsSync(join(root, "src/configs/common/.gitkeep")));
    assert.ok(existsSync(join(root, "src/configs/claude/.gitkeep")));
    assert.ok(existsSync(join(root, "src/configs/codex/.gitkeep")));
  });
});

test("init scaffolds src/plugins/.gitkeep", async () => {
  await withSandbox(async (root) => {
    await initHarness({ repoRoot: root, marketplace: "shop", vendors: ["claude"], silent: true });
    assert.ok(existsSync(join(root, "src/plugins/.gitkeep")));
  });
});

test("init writes .gitignore with dist/", async () => {
  await withSandbox(async (root) => {
    await initHarness({ repoRoot: root, marketplace: "shop", vendors: ["claude"], silent: true });
    const ignore = readFileSync(join(root, ".gitignore"), "utf8");
    assert.match(ignore, /^dist\/?$/m);
  });
});

test("init appends to an existing .gitignore without overwriting", async () => {
  await withSandbox(async (root) => {
    writeFileSync(join(root, ".gitignore"), "node_modules/\n");
    await initHarness({ repoRoot: root, marketplace: "shop", vendors: ["claude"], silent: true });
    const ignore = readFileSync(join(root, ".gitignore"), "utf8");
    assert.match(ignore, /node_modules\//);
    assert.match(ignore, /^dist\/?$/m);
  });
});

test("init refuses to overwrite an existing harness.yaml", async () => {
  await withSandbox(async (root) => {
    writeFileSync(join(root, "harness.yaml"), "marketplace: old\nvendors: [claude]\n");
    await assert.rejects(
      initHarness({ repoRoot: root, marketplace: "new", vendors: ["claude"], silent: true }),
      /harness\.yaml/,
    );
  });
});
