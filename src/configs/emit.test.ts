import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { emitConfigsManifest } from "./emit.js";
import type { Vendor } from "../vendor/schema.js";

function fakeVendor(name: string): Vendor {
  return {
    name,
    home: `/tmp/.${name}`,
    pluginManifestPath: `.${name}-plugin/plugin.json`,
    marketplaceManifestPath: `${name}/.${name}-plugin/marketplace.json`,
    vendorOutDir: (outRoot) => join(outRoot, name),
    pluginOutDir: (outRoot, pluginName) => join(outRoot, name, "plugins", pluginName),
    configsOutDir: (outRoot) => join(outRoot, name, "configs"),
    emitPluginManifest: async () => undefined,
    emitMarketplaceManifest: async () => undefined,
    install: async () => undefined,
    uninstall: async () => undefined,
  };
}

const claude = fakeVendor("claude");

async function withSandbox(fn: (outRoot: string) => Promise<void> | void): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "harness-configs-emit-"));
  const outRoot = join(root, "dist");
  mkdirSync(outRoot, { recursive: true });
  try {
    await fn(outRoot);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("emitConfigsManifest writes dist/configs.json with the manifest", async () => {
  await withSandbox(async (outRoot) => {
    mkdirSync(join(outRoot, "claude/configs"), { recursive: true });
    writeFileSync(join(outRoot, "claude/configs/AGENTS.md"), "");
    await emitConfigsManifest({ outRoot, vendors: [claude] });
    const target = join(outRoot, "configs.json");
    assert.equal(existsSync(target), true);
    const parsed = JSON.parse(readFileSync(target, "utf8")) as { links: unknown[] };
    assert.deepEqual(parsed, {
      links: [
        {
          src: "claude/configs/AGENTS.md",
          vendors: ["claude"],
          destRel: "AGENTS.md",
          kind: "file",
        },
      ],
    });
  });
});

test("emitConfigsManifest writes empty manifest when no vendor has a configs/ dir", async () => {
  await withSandbox(async (outRoot) => {
    await emitConfigsManifest({ outRoot, vendors: [claude] });
    const parsed = JSON.parse(readFileSync(join(outRoot, "configs.json"), "utf8")) as unknown;
    assert.deepEqual(parsed, { links: [] });
  });
});
