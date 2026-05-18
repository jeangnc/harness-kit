import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { discoverPluginsForVendor, readMarketplaceName } from "./discovery.js";
import type { Vendor } from "../vendor/schema.js";

function fakeVendor(name: string): Vendor {
  return {
    name,
    home: `/tmp/.${name}`,
    pluginManifestPath: `.${name}-plugin/plugin.json`,
    emitPluginManifest: async () => undefined,
    install: async () => undefined,
    uninstall: async () => undefined,
  };
}

async function withSandbox<T>(fn: (distRoot: string) => Promise<T>): Promise<T> {
  const sandbox = mkdtempSync(join(tmpdir(), "harness-kit-discovery-"));
  try {
    return await fn(sandbox);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

test("discoverPluginsForVendor walks dist/plugins/<vendor>/<plugin>/ and reads the vendor manifest", async () => {
  await withSandbox(async (distRoot) => {
    const claude = fakeVendor("claude");
    const pluginDir = join(distRoot, "plugins/claude/alpha");
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
    mkdirSync(join(distRoot, "plugins/claude/rogue"), { recursive: true });
    const plugins = await discoverPluginsForVendor(distRoot, claude);
    assert.deepEqual(plugins, []);
  });
});

test("discoverPluginsForVendor throws on a malformed manifest", async () => {
  await withSandbox(async (distRoot) => {
    const claude = fakeVendor("claude");
    const pluginDir = join(distRoot, "plugins/claude/alpha");
    mkdirSync(join(pluginDir, ".claude-plugin"), { recursive: true });
    writeFileSync(join(pluginDir, ".claude-plugin/plugin.json"), JSON.stringify({ name: "alpha" }));
    await assert.rejects(discoverPluginsForVendor(distRoot, claude), /version/i);
  });
});

test("readMarketplaceName reads dist/.claude-plugin/marketplace.json", async () => {
  await withSandbox(async (distRoot) => {
    mkdirSync(join(distRoot, ".claude-plugin"), { recursive: true });
    writeFileSync(
      join(distRoot, ".claude-plugin/marketplace.json"),
      JSON.stringify({ name: "shop" }),
    );
    assert.equal(await readMarketplaceName(distRoot), "shop");
  });
});
