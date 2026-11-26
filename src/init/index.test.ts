import { test } from "node:test";
import { deepEqual, equal, match, ok, rejects } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import yaml from "js-yaml";

import { initHarness, type InitOptions } from "./index.js";
import { consumerWorkflow } from "../publish/workflow.js";

async function withSandbox<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "harness-kit-init-"));
  try {
    return await fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function options(root: string, overrides: Partial<InitOptions> = {}): InitOptions {
  return {
    repoRoot: root,
    marketplace: "shop",
    owner: { name: "acme" },
    vendors: ["claude"],
    silent: true,
    ...overrides,
  };
}

test("init writes harness.yaml with marketplace, owner and vendors", async () => {
  await withSandbox(async (root) => {
    await initHarness(options(root, { vendors: ["claude", "codex"] }));
    const doc = yaml.load(readFileSync(join(root, "harness.yaml"), "utf8"));
    deepEqual(doc, { marketplace: "shop", owner: { name: "acme" }, vendors: ["claude", "codex"] });
  });
});

test("init scaffolds the plugins and configs directories", async () => {
  await withSandbox(async (root) => {
    await initHarness(options(root));
    ok(existsSync(join(root, "plugins/.gitkeep")));
    ok(existsSync(join(root, "configs/.gitkeep")));
  });
});

test("init writes the consumer release workflow", async () => {
  await withSandbox(async (root) => {
    await initHarness(options(root));
    equal(readFileSync(join(root, ".github/workflows/harness.yml"), "utf8"), consumerWorkflow());
  });
});

test("init gitignores the .harness build dir", async () => {
  await withSandbox(async (root) => {
    await initHarness(options(root));
    match(readFileSync(join(root, ".gitignore"), "utf8"), /^\.harness\/$/m);
  });
});

test("init appends to an existing .gitignore without overwriting", async () => {
  await withSandbox(async (root) => {
    writeFileSync(join(root, ".gitignore"), "node_modules/");
    await initHarness(options(root));
    equal(readFileSync(join(root, ".gitignore"), "utf8"), "node_modules/\n.harness/\n");
  });
});

test("init leaves a .gitignore that already ignores .harness unchanged", async () => {
  await withSandbox(async (root) => {
    writeFileSync(join(root, ".gitignore"), "/.harness\n");
    await initHarness(options(root));
    equal(readFileSync(join(root, ".gitignore"), "utf8"), "/.harness\n");
  });
});

test("init refuses to overwrite an existing harness.yaml", async () => {
  await withSandbox(async (root) => {
    writeFileSync(join(root, "harness.yaml"), "marketplace: old\n");
    await rejects(initHarness(options(root)), /harness\.yaml/);
  });
});

test("init refuses to overwrite an existing workflow before writing anything", async () => {
  await withSandbox(async (root) => {
    mkdirSync(join(root, ".github/workflows"), { recursive: true });
    writeFileSync(join(root, ".github/workflows/harness.yml"), "name: mine\n");
    await rejects(initHarness(options(root)), /harness\.yml/);
    ok(!existsSync(join(root, "harness.yaml")));
  });
});
