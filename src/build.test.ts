import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "./build.js";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));

async function withSandbox<T>(fn: (srcRoot: string, outRoot: string) => Promise<T>): Promise<T> {
  const sandbox = mkdtempSync(join(repoRoot, ".test-tmp-build-"));
  const srcRoot = join(sandbox, "src");
  const outRoot = join(sandbox, "out");
  writeFileSync(join(sandbox, "harness.yaml"), "marketplace: build-test\nvendors:\n  - claude\n");
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
        name: "build-test",
        owner: { name: "harness-kit-tests" },
        plugins: [{ name: "foo", source: "./plugins/foo" }],
      },
      null,
      2,
    ) + "\n",
  );
  return fn(srcRoot, outRoot).finally(() => rmSync(sandbox, { recursive: true, force: true }));
}

test("build emits SKILL.md to outRoot when given explicit paths", async () => {
  await withSandbox(async (srcRoot, outRoot) => {
    await build({ srcRoot, outRoot, silent: true });
    assert.ok(existsSync(join(outRoot, "plugins/claude/foo/skills/bar/SKILL.md")));
  });
});

test("build cleans the outRoot/plugins tree before compiling", async () => {
  await withSandbox(async (srcRoot, outRoot) => {
    const stalePath = join(outRoot, "plugins/old/skills/gone/SKILL.md");
    mkdirSync(join(outRoot, "plugins/old/skills/gone"), { recursive: true });
    writeFileSync(stalePath, "stale\n");
    await build({ srcRoot, outRoot, silent: true });
    assert.ok(!existsSync(stalePath), "stale plugin should be removed");
    assert.ok(existsSync(join(outRoot, "plugins/claude/foo/skills/bar/SKILL.md")));
  });
});

test("build forwards bodyInvariants to compile", async () => {
  await withSandbox(async (srcRoot, outRoot) => {
    const flagFOO = (body: string): string[] => (body.includes("Bar") ? ["found Bar"] : []);
    await assert.rejects(
      build({ srcRoot, outRoot, silent: true, bodyInvariants: [flagFOO] }),
      /found Bar/,
    );
  });
});

test("build writes a success line to stdout when not silent", async () => {
  await withSandbox(async (srcRoot, outRoot) => {
    const original = console.log;
    const lines: string[] = [];
    console.log = (msg: string) => lines.push(msg);
    try {
      await build({ srcRoot, outRoot });
    } finally {
      console.log = original;
    }
    const joined = lines.join("\n");
    assert.match(joined, /compiled →/);
    assert.ok(joined.includes(outRoot));
  });
});
