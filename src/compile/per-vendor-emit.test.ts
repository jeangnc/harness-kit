import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { compile } from "./index.js";
import { claudeVendor } from "../vendors/claude/index.js";
import { codexVendor } from "../vendors/codex/index.js";

async function withSandbox(fn: (root: string) => Promise<void> | void): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "harness-per-vendor-emit-"));
  try {
    await fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function seedMinimalPlugin(srcRoot: string, pluginName: string): void {
  mkdirSync(join(srcRoot, ".claude-plugin"), { recursive: true });
  writeFileSync(
    join(srcRoot, ".claude-plugin/marketplace.json"),
    JSON.stringify({
      name: "test-marketplace",
      owner: { name: "test" },
      plugins: [{ name: pluginName, source: "./" + pluginName }],
    }),
  );
  const pluginDir = join(srcRoot, pluginName);
  mkdirSync(join(pluginDir, ".claude-plugin"), { recursive: true });
  writeFileSync(
    join(pluginDir, ".claude-plugin/plugin.json"),
    JSON.stringify({ name: pluginName, version: "1.0.0", description: "test plugin" }),
  );
}

test("compile emits one subtree per declared vendor under dist/plugins/<vendor>/<name>/", async () => {
  await withSandbox(async (root) => {
    const srcRoot = join(root, "src");
    const outRoot = join(root, "dist");
    seedMinimalPlugin(srcRoot, "alpha");

    await compile({ srcRoot, outRoot, vendors: [claudeVendor, codexVendor] });

    assert.equal(
      existsSync(join(outRoot, "plugins/claude/alpha/.claude-plugin/plugin.json")),
      true,
    );
    assert.equal(existsSync(join(outRoot, "plugins/codex/alpha/.codex-plugin/plugin.json")), true);
  });
});

test("compile writes each vendor's plugin manifest at the vendor-declared path", async () => {
  await withSandbox(async (root) => {
    const srcRoot = join(root, "src");
    const outRoot = join(root, "dist");
    seedMinimalPlugin(srcRoot, "beta");

    await compile({ srcRoot, outRoot, vendors: [claudeVendor, codexVendor] });

    const claudeManifest = JSON.parse(
      readFileSync(join(outRoot, "plugins/claude/beta/.claude-plugin/plugin.json"), "utf8"),
    ) as { name: string; version: string };
    const codexManifest = JSON.parse(
      readFileSync(join(outRoot, "plugins/codex/beta/.codex-plugin/plugin.json"), "utf8"),
    ) as { name: string; version: string };

    assert.equal(claudeManifest.name, "beta");
    assert.equal(claudeManifest.version, "1.0.0");
    assert.equal(codexManifest.name, "beta");
    assert.equal(codexManifest.version, "1.0.0");
  });
});

test("compile only emits subtrees for vendors passed in (gemini absent → no gemini dir)", async () => {
  await withSandbox(async (root) => {
    const srcRoot = join(root, "src");
    const outRoot = join(root, "dist");
    seedMinimalPlugin(srcRoot, "gamma");

    await compile({ srcRoot, outRoot, vendors: [claudeVendor] });

    assert.equal(existsSync(join(outRoot, "plugins/claude/gamma")), true);
    assert.equal(existsSync(join(outRoot, "plugins/codex")), false);
    assert.equal(existsSync(join(outRoot, "plugins/gemini")), false);
  });
});

test("compile mirrors skills inside each vendor subtree", async () => {
  await withSandbox(async (root) => {
    const srcRoot = join(root, "src");
    const outRoot = join(root, "dist");
    seedMinimalPlugin(srcRoot, "delta");
    const skillDir = join(srcRoot, "delta/skills/widget");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      "---\nname: widget\ndescription: a widget skill for testing\n---\n\nBody.\n",
    );

    await compile({ srcRoot, outRoot, vendors: [claudeVendor, codexVendor] });

    assert.equal(existsSync(join(outRoot, "plugins/claude/delta/skills/widget/SKILL.md")), true);
    assert.equal(existsSync(join(outRoot, "plugins/codex/delta/skills/widget/SKILL.md")), true);
  });
});
