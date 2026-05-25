import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { compilePlugins } from "./index.js";
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
      plugins: [{ name: pluginName, source: `./plugins/${pluginName}` }],
    }),
  );
  const pluginDir = join(srcRoot, "plugins", pluginName);
  mkdirSync(join(pluginDir, ".claude-plugin"), { recursive: true });
  writeFileSync(
    join(pluginDir, ".claude-plugin/plugin.json"),
    JSON.stringify({ name: pluginName, version: "1.0.0", description: "test plugin" }),
  );
}

test("compilePlugins emits one subtree per declared vendor under dist/<vendor>/plugins/<name>/", async () => {
  await withSandbox(async (root) => {
    const srcRoot = join(root, "src");
    const outRoot = join(root, "dist");
    seedMinimalPlugin(srcRoot, "alpha");

    await compilePlugins({ srcRoot, outRoot, vendors: [claudeVendor, codexVendor] });

    assert.equal(
      existsSync(join(outRoot, "claude/plugins/alpha/.claude-plugin/plugin.json")),
      true,
    );
    assert.equal(existsSync(join(outRoot, "codex/plugins/alpha/.codex-plugin/plugin.json")), true);
  });
});

test("compilePlugins writes each vendor's plugin manifest at the vendor-declared path", async () => {
  await withSandbox(async (root) => {
    const srcRoot = join(root, "src");
    const outRoot = join(root, "dist");
    seedMinimalPlugin(srcRoot, "beta");

    await compilePlugins({ srcRoot, outRoot, vendors: [claudeVendor, codexVendor] });

    const claudeManifest = JSON.parse(
      readFileSync(join(outRoot, "claude/plugins/beta/.claude-plugin/plugin.json"), "utf8"),
    ) as { name: string; version: string };
    const codexManifest = JSON.parse(
      readFileSync(join(outRoot, "codex/plugins/beta/.codex-plugin/plugin.json"), "utf8"),
    ) as { name: string; version: string };

    assert.equal(claudeManifest.name, "beta");
    assert.equal(claudeManifest.version, "1.0.0");
    assert.equal(codexManifest.name, "beta");
    assert.equal(codexManifest.version, "1.0.0");
  });
});

test("compilePlugins only emits subtrees for vendors passed in (gemini absent → no gemini dir)", async () => {
  await withSandbox(async (root) => {
    const srcRoot = join(root, "src");
    const outRoot = join(root, "dist");
    seedMinimalPlugin(srcRoot, "gamma");

    await compilePlugins({ srcRoot, outRoot, vendors: [claudeVendor] });

    assert.equal(existsSync(join(outRoot, "claude/plugins/gamma")), true);
    assert.equal(existsSync(join(outRoot, "codex")), false);
    assert.equal(existsSync(join(outRoot, "gemini")), false);
  });
});

test("compilePlugins mirrors skills inside each vendor subtree", async () => {
  await withSandbox(async (root) => {
    const srcRoot = join(root, "src");
    const outRoot = join(root, "dist");
    seedMinimalPlugin(srcRoot, "delta");
    const skillDir = join(srcRoot, "plugins/delta/skills/widget");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      "---\nname: widget\ndescription: a widget skill for testing\n---\n\nBody.\n",
    );

    await compilePlugins({ srcRoot, outRoot, vendors: [claudeVendor, codexVendor] });

    assert.equal(existsSync(join(outRoot, "claude/plugins/delta/skills/widget/SKILL.md")), true);
    assert.equal(existsSync(join(outRoot, "codex/plugins/delta/skills/widget/SKILL.md")), true);
  });
});

const plainMdPlaceholderCases = [
  { placeholder: "include", directive: "{{include:./sibling.md}}", resolved: /shared body/ },
  { placeholder: "ref", directive: "{{ref:./sibling.md}}", resolved: /sibling\.md/ },
] as const;

for (const { placeholder, directive, resolved } of plainMdPlaceholderCases) {
  test(`compilePlugins resolves {{${placeholder}}} in a plain plugin-root .md file`, async () => {
    await withSandbox(async (root) => {
      const srcRoot = join(root, "src");
      const outRoot = join(root, "dist");
      seedMinimalPlugin(srcRoot, "epsilon");
      const pluginDir = join(srcRoot, "plugins/epsilon");
      writeFileSync(join(pluginDir, "sibling.md"), "shared body\n");
      writeFileSync(join(pluginDir, "doc.md"), `# Doc\n\n${directive}\n`);

      await compilePlugins({ srcRoot, outRoot, vendors: [claudeVendor] });

      const rendered = readFileSync(join(outRoot, "claude/plugins/epsilon/doc.md"), "utf8");
      assert.match(rendered, resolved);
      assert.doesNotMatch(rendered, /\{\{/);
    });
  });
}

test("compilePlugins fails when a plain .md file has an unknown placeholder prefix", async () => {
  await withSandbox(async (root) => {
    const srcRoot = join(root, "src");
    const outRoot = join(root, "dist");
    seedMinimalPlugin(srcRoot, "zeta");
    writeFileSync(join(srcRoot, "plugins/zeta", "doc.md"), "see {{ghost:./x.md}}\n");

    await assert.rejects(compilePlugins({ srcRoot, outRoot, vendors: [claudeVendor] }));
  });
});
