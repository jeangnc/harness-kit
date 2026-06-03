import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadHarnessConfig, resolveRoots } from "./harness.js";

async function withSandbox(fn: (dir: string) => Promise<void> | void): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "harness-yaml-test-"));
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("loadHarnessConfig parses a valid harness.yaml", async () => {
  await withSandbox(async (dir) => {
    writeFileSync(
      join(dir, "harness.yaml"),
      "marketplace: my-market\nvendors:\n  - claude\n  - codex\n",
    );
    const cfg = await loadHarnessConfig(dir);
    assert.equal(cfg.marketplace, "my-market");
    assert.deepEqual(cfg.vendors, ["claude", "codex"]);
  });
});

test("loadHarnessConfig prefers harness.yml when harness.yaml absent", async () => {
  await withSandbox(async (dir) => {
    writeFileSync(join(dir, "harness.yml"), "marketplace: m\nvendors: [claude]\n");
    const cfg = await loadHarnessConfig(dir);
    assert.equal(cfg.marketplace, "m");
    assert.deepEqual(cfg.vendors, ["claude"]);
  });
});

test("loadHarnessConfig throws when both harness.yaml and harness.yml exist", async () => {
  await withSandbox(async (dir) => {
    writeFileSync(join(dir, "harness.yaml"), "marketplace: a\nvendors: [claude]\n");
    writeFileSync(join(dir, "harness.yml"), "marketplace: b\nvendors: [codex]\n");
    await assert.rejects(
      async () => loadHarnessConfig(dir),
      /both harness\.yaml and harness\.yml/i,
    );
  });
});

test("loadHarnessConfig throws when no harness file present", async () => {
  await withSandbox(async (dir) => {
    mkdirSync(join(dir, "src"));
    await assert.rejects(async () => loadHarnessConfig(dir), /harness\.yaml not found/i);
  });
});

test("loadHarnessConfig throws when marketplace is missing", async () => {
  await withSandbox(async (dir) => {
    writeFileSync(join(dir, "harness.yaml"), "vendors: [claude]\n");
    await assert.rejects(async () => loadHarnessConfig(dir), /marketplace/);
  });
});

test("loadHarnessConfig throws when vendors is empty", async () => {
  await withSandbox(async (dir) => {
    writeFileSync(join(dir, "harness.yaml"), "marketplace: m\nvendors: []\n");
    await assert.rejects(async () => loadHarnessConfig(dir), /at least one vendor/i);
  });
});

test("loadHarnessConfig throws when vendors contains a non-string", async () => {
  await withSandbox(async (dir) => {
    writeFileSync(join(dir, "harness.yaml"), "marketplace: m\nvendors:\n  - 123\n");
    await assert.rejects(async () => loadHarnessConfig(dir), /vendors/);
  });
});

test("loadHarnessConfig throws on malformed YAML", async () => {
  await withSandbox(async (dir) => {
    writeFileSync(join(dir, "harness.yaml"), "marketplace: m\n  bad indent: x\n");
    await assert.rejects(async () => loadHarnessConfig(dir), /harness\.yaml/i);
  });
});

test("loadHarnessConfig parses an optional roots map", async () => {
  await withSandbox(async (dir) => {
    writeFileSync(
      join(dir, "harness.yaml"),
      "marketplace: m\nvendors: [claude]\nroots:\n  shared: ./src/shared\n",
    );
    const cfg = await loadHarnessConfig(dir);
    assert.deepEqual(cfg.roots, { shared: "./src/shared" });
  });
});

test("loadHarnessConfig leaves roots undefined when absent", async () => {
  await withSandbox(async (dir) => {
    writeFileSync(join(dir, "harness.yaml"), "marketplace: m\nvendors: [claude]\n");
    const cfg = await loadHarnessConfig(dir);
    assert.equal(cfg.roots, undefined);
  });
});

test("loadHarnessConfig rejects an empty roots value", async () => {
  await withSandbox(async (dir) => {
    writeFileSync(
      join(dir, "harness.yaml"),
      "marketplace: m\nvendors: [claude]\nroots:\n  shared: ''\n",
    );
    await assert.rejects(async () => loadHarnessConfig(dir), /roots/);
  });
});

test("resolveRoots returns an empty map when nothing is declared", () => {
  assert.deepEqual(resolveRoots("/repo", undefined), {});
});

test("resolveRoots resolves declared paths against the repo root", () => {
  assert.deepEqual(resolveRoots("/repo", { shared: "./src/shared" }), {
    shared: "/repo/src/shared",
  });
});
