import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { compile } from "./compile.js";
import { AGENT_PLUGINS_SCHEMA } from "./plugin/index.js";

async function withSandbox<T>(fn: (repoRoot: string, outRoot: string) => Promise<T>): Promise<T> {
  const repoRoot = mkdtempSync(join(tmpdir(), "harness-kit-compile-"));
  writeFileSync(
    join(repoRoot, "harness.yaml"),
    "marketplace: compile-test\nowner:\n  name: harness-kit-tests\nvendors:\n  - claude\n",
  );
  const pluginDir = join(repoRoot, "plugins/foo");
  mkdirSync(join(pluginDir, "skills/bar"), { recursive: true });
  writeFileSync(
    join(pluginDir, "skills/bar/SKILL.md"),
    "---\nname: bar\ndescription: fixture\n---\n\n# Bar\n",
  );
  writeFileSync(
    join(pluginDir, "plugin.json"),
    JSON.stringify({
      $schema: AGENT_PLUGINS_SCHEMA,
      name: "foo",
      version: "0.0.1",
      description: "fixture",
    }),
  );
  return fn(repoRoot, join(repoRoot, ".harness")).finally(() =>
    rmSync(repoRoot, { recursive: true, force: true }),
  );
}

test("compile emits SKILL.md into the repo build dir", async () => {
  await withSandbox(async (repoRoot, outRoot) => {
    await compile({ repoRoot, silent: true });
    assert.ok(existsSync(join(outRoot, "claude/plugins/foo/skills/bar/SKILL.md")));
  });
});

test("compile removes stale build output before building", async () => {
  await withSandbox(async (repoRoot, outRoot) => {
    const stalePath = join(outRoot, "claude/plugins/old/skills/gone/SKILL.md");
    mkdirSync(join(outRoot, "claude/plugins/old/skills/gone"), { recursive: true });
    writeFileSync(stalePath, "stale\n");
    await compile({ repoRoot, silent: true });
    assert.ok(!existsSync(stalePath), "stale plugin should be removed");
    assert.ok(existsSync(join(outRoot, "claude/plugins/foo/skills/bar/SKILL.md")));
  });
});

test("compile writes a success line to stdout when not silent", async () => {
  await withSandbox(async (repoRoot, outRoot) => {
    const original = console.log;
    const lines: string[] = [];
    console.log = (msg: string) => lines.push(msg);
    try {
      await compile({ repoRoot });
    } finally {
      console.log = original;
    }
    const joined = lines.join("\n");
    assert.match(joined, /built →/);
    assert.ok(joined.includes(outRoot));
  });
});
