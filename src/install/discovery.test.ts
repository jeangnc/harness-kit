import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { discoverPluginsForVendor, readMarketplaceName } from "./discovery.js";
import { makeFakeVendor as fakeVendor } from "../vendor/fakeVendor.testutil.js";

async function withSandbox<T>(fn: (distRoot: string) => Promise<T>): Promise<T> {
  const sandbox = mkdtempSync(join(tmpdir(), "harness-kit-discovery-"));
  try {
    return await fn(sandbox);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

test("discoverPluginsForVendor walks dist/<vendor>/plugins/<plugin>/ and reads the vendor manifest", async () => {
  await withSandbox(async (distRoot) => {
    const claude = fakeVendor("claude");
    const pluginDir = join(distRoot, "claude/plugins/alpha");
    mkdirSync(join(pluginDir, ".claude-plugin"), { recursive: true });
    writeFileSync(
      join(pluginDir, ".claude-plugin/plugin.json"),
      JSON.stringify({ name: "alpha", version: "1.2.3" }),
    );
    const plugins = await discoverPluginsForVendor(distRoot, claude);
    assert.deepEqual(plugins, [{ name: "alpha", path: pluginDir, version: "1.2.3" }]);
  });
});

test("discoverPluginsForVendor returns [] when vendor dist subtree does not exist", async () => {
  await withSandbox(async (distRoot) => {
    const claude = fakeVendor("claude");
    const plugins = await discoverPluginsForVendor(distRoot, claude);
    assert.deepEqual(plugins, []);
  });
});

test("discoverPluginsForVendor skips folders without the vendor manifest", async () => {
  await withSandbox(async (distRoot) => {
    const claude = fakeVendor("claude");
    mkdirSync(join(distRoot, "claude/plugins/rogue"), { recursive: true });
    const plugins = await discoverPluginsForVendor(distRoot, claude);
    assert.deepEqual(plugins, []);
  });
});

test("discoverPluginsForVendor ignores sibling subtrees like configs/", async () => {
  await withSandbox(async (distRoot) => {
    const claude = fakeVendor("claude");
    mkdirSync(join(distRoot, "claude/configs"), { recursive: true });
    writeFileSync(join(distRoot, "claude/configs/AGENTS.md"), "x");
    const plugins = await discoverPluginsForVendor(distRoot, claude);
    assert.deepEqual(plugins, []);
  });
});

test("discoverPluginsForVendor throws on a malformed manifest", async () => {
  await withSandbox(async (distRoot) => {
    const claude = fakeVendor("claude");
    const pluginDir = join(distRoot, "claude/plugins/alpha");
    mkdirSync(join(pluginDir, ".claude-plugin"), { recursive: true });
    writeFileSync(join(pluginDir, ".claude-plugin/plugin.json"), JSON.stringify({ name: "alpha" }));
    await assert.rejects(discoverPluginsForVendor(distRoot, claude), /version/i);
  });
});

test("readMarketplaceName reads <vendor>/<marketplaceManifestPath>", async () => {
  await withSandbox(async (distRoot) => {
    const claude = fakeVendor("claude");
    mkdirSync(join(distRoot, "claude/.claude-plugin"), { recursive: true });
    writeFileSync(
      join(distRoot, "claude/.claude-plugin/marketplace.json"),
      JSON.stringify({ name: "shop" }),
    );
    assert.equal(await readMarketplaceName(distRoot, claude), "shop");
  });
});
