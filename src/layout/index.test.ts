import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { HarnessConfig } from "../config/harness.js";
import { AGENT_PLUGINS_SCHEMA } from "../plugin/index.js";
import { layoutAt, loadCatalog } from "./index.js";

const config: HarnessConfig = {
  marketplace: "test-marketplace",
  owner: { name: "Acme" },
  vendors: ["claude"],
};

async function withRepo<T>(fn: (repoRoot: string) => Promise<T>): Promise<T> {
  const repoRoot = mkdtempSync(join(tmpdir(), "harness-kit-layout-"));
  return fn(repoRoot).finally(() => rmSync(repoRoot, { recursive: true, force: true }));
}

function writePlugin(repoRoot: string, folder: string, manifest: Record<string, unknown>): void {
  const dir = join(repoRoot, "plugins", folder);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "plugin.json"), JSON.stringify(manifest));
}

function manifestFor(name: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { $schema: AGENT_PLUGINS_SCHEMA, name, version: "1.0.0", description: "demo", ...extra };
}

test("layoutAt places plugins, configs, and the build dir under the repo root", () => {
  const layout = layoutAt("/repo");
  assert.deepEqual(layout, {
    repoRoot: "/repo",
    pluginsDir: "/repo/plugins",
    configsDir: "/repo/configs",
    buildDir: "/repo/.harness",
  });
});

test("loadCatalog discovers every plugin folder sorted by name", async () => {
  await withRepo(async (repoRoot) => {
    writePlugin(repoRoot, "zeta", manifestFor("zeta"));
    writePlugin(repoRoot, "alpha", manifestFor("alpha"));
    const result = await loadCatalog(layoutAt(repoRoot), config);
    if (!result.ok) assert.fail(JSON.stringify(result.error));
    assert.deepEqual(
      result.value.plugins.map((plugin) => plugin.name),
      ["alpha", "zeta"],
    );
  });
});

test("loadCatalog takes marketplace name and owner from harness.yaml", async () => {
  await withRepo(async (repoRoot) => {
    const result = await loadCatalog(layoutAt(repoRoot), config);
    if (!result.ok) assert.fail(JSON.stringify(result.error));
    assert.equal(result.value.name, "test-marketplace");
    assert.deepEqual(result.value.owner, { name: "Acme" });
  });
});

test("loadCatalog resolves conventional content dirs inside the plugin folder", async () => {
  await withRepo(async (repoRoot) => {
    writePlugin(repoRoot, "foo", manifestFor("foo"));
    const result = await loadCatalog(layoutAt(repoRoot), config);
    if (!result.ok) assert.fail(JSON.stringify(result.error));
    const [plugin] = result.value.plugins;
    assert.ok(plugin);
    assert.equal(plugin.manifestPath, join(repoRoot, "plugins/foo/plugin.json"));
    assert.equal(plugin.hooksDir, join(repoRoot, "plugins/foo/hooks"));
  });
});

test("loadCatalog ignores dot-prefixed folders under plugins", async () => {
  await withRepo(async (repoRoot) => {
    mkdirSync(join(repoRoot, "plugins/.cache"), { recursive: true });
    const result = await loadCatalog(layoutAt(repoRoot), config);
    if (!result.ok) assert.fail(JSON.stringify(result.error));
    assert.equal(result.value.plugins.length, 0);
  });
});

test("loadCatalog fails when a plugin folder has no plugin.json", async () => {
  await withRepo(async (repoRoot) => {
    mkdirSync(join(repoRoot, "plugins/foo"), { recursive: true });
    const result = await loadCatalog(layoutAt(repoRoot), config);
    if (result.ok) assert.fail("expected error");
    assert.equal(result.error.kind, "manifest-missing");
  });
});

test("loadCatalog fails when plugin.json is not valid JSON", async () => {
  await withRepo(async (repoRoot) => {
    mkdirSync(join(repoRoot, "plugins/foo"), { recursive: true });
    writeFileSync(join(repoRoot, "plugins/foo/plugin.json"), "{");
    const result = await loadCatalog(layoutAt(repoRoot), config);
    if (result.ok) assert.fail("expected error");
    assert.equal(result.error.kind, "manifest-unreadable");
  });
});

test("loadCatalog fails when plugin.json omits the Agent Plugins $schema", async () => {
  await withRepo(async (repoRoot) => {
    writePlugin(repoRoot, "foo", { name: "foo", version: "1.0.0", description: "demo" });
    const result = await loadCatalog(layoutAt(repoRoot), config);
    if (result.ok) assert.fail("expected error");
    assert.equal(result.error.kind, "manifest-invalid");
  });
});

test("loadCatalog fails when plugin.json carries a vendor field at the top level", async () => {
  await withRepo(async (repoRoot) => {
    writePlugin(repoRoot, "foo", manifestFor("foo", { dependencies: ["bar"] }));
    const result = await loadCatalog(layoutAt(repoRoot), config);
    if (result.ok) assert.fail("expected error");
    assert.equal(result.error.kind, "manifest-invalid");
  });
});

test("loadCatalog fails when the manifest name differs from its folder", async () => {
  await withRepo(async (repoRoot) => {
    writePlugin(repoRoot, "foo", manifestFor("bar"));
    const result = await loadCatalog(layoutAt(repoRoot), config);
    if (result.ok) assert.fail("expected error");
    assert.equal(result.error.kind, "plugin-name-mismatch");
  });
});

test("loadCatalog reads hookRequires from extensions.harness", async () => {
  await withRepo(async (repoRoot) => {
    const hookRequires = [{ event: "SessionStart", skill: "foo:bar" }];
    writePlugin(repoRoot, "foo", manifestFor("foo", { extensions: { harness: { hookRequires } } }));
    const result = await loadCatalog(layoutAt(repoRoot), config);
    if (!result.ok) assert.fail(JSON.stringify(result.error));
    assert.deepEqual(result.value.plugins[0]?.hookRequires, hookRequires);
  });
});

test("loadCatalog fails when extensions.harness has an unknown key", async () => {
  await withRepo(async (repoRoot) => {
    writePlugin(repoRoot, "foo", manifestFor("foo", { extensions: { harness: { bogus: 1 } } }));
    const result = await loadCatalog(layoutAt(repoRoot), config);
    if (result.ok) assert.fail("expected error");
    assert.equal(result.error.kind, "manifest-invalid");
  });
});
