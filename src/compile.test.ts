import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { compile } from "./compile.js";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));

async function withSandbox<T>(fn: (srcRoot: string, outRoot: string) => Promise<T>): Promise<T> {
  const sandbox = mkdtempSync(join(repoRoot, ".test-tmp-compile-"));
  const srcRoot = join(sandbox, "src");
  const outRoot = join(sandbox, "out");
  writeFileSync(join(sandbox, "harness.yaml"), "marketplace: compile-test\nvendors:\n  - claude\n");
  const skillDir = join(srcRoot, "plugins/foo/skills/bar");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.ts"),
    `import { defineSkill } from "#harness-kit";\nexport default defineSkill({ name: "bar", description: "fixture" });\n`,
  );
  writeFileSync(join(skillDir, "body.md"), "# Bar\n");
  const pluginManifestDir = join(srcRoot, "plugins/foo/.claude-plugin");
  mkdirSync(pluginManifestDir, { recursive: true });
  writeFileSync(
    join(pluginManifestDir, "plugin.json"),
    JSON.stringify({ name: "foo", version: "0.0.1", description: "fixture" }, null, 2) + "\n",
  );
  const marketplaceDir = join(srcRoot, ".claude-plugin");
  mkdirSync(marketplaceDir, { recursive: true });
  writeFileSync(
    join(marketplaceDir, "marketplace.json"),
    JSON.stringify(
      {
        name: "compile-test",
        owner: { name: "harness-kit-tests" },
        plugins: [{ name: "foo", source: "./plugins/foo" }],
      },
      null,
      2,
    ) + "\n",
  );
  return fn(srcRoot, outRoot).finally(() => rmSync(sandbox, { recursive: true, force: true }));
}

test("compile emits SKILL.md to outRoot when given explicit paths", async () => {
  await withSandbox(async (srcRoot, outRoot) => {
    await compile({ srcRoot, outRoot, silent: true });
    assert.ok(existsSync(join(outRoot, "claude/plugins/foo/skills/bar/SKILL.md")));
  });
});

test("compile cleans each vendor's dist subtree before compiling", async () => {
  await withSandbox(async (srcRoot, outRoot) => {
    const stalePath = join(outRoot, "claude/plugins/old/skills/gone/SKILL.md");
    mkdirSync(join(outRoot, "claude/plugins/old/skills/gone"), { recursive: true });
    writeFileSync(stalePath, "stale\n");
    await compile({ srcRoot, outRoot, silent: true });
    assert.ok(!existsSync(stalePath), "stale plugin should be removed");
    assert.ok(existsSync(join(outRoot, "claude/plugins/foo/skills/bar/SKILL.md")));
  });
});

test("compile writes a success line to stdout when not silent", async () => {
  await withSandbox(async (srcRoot, outRoot) => {
    const original = console.log;
    const lines: string[] = [];
    console.log = (msg: string) => lines.push(msg);
    try {
      await compile({ srcRoot, outRoot });
    } finally {
      console.log = original;
    }
    const joined = lines.join("\n");
    assert.match(joined, /compiled →/);
    assert.ok(joined.includes(outRoot));
  });
});
