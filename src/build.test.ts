import { test } from "node:test";
import { match, ok } from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { build } from "./build.js";
import { AGENT_PLUGINS_SCHEMA } from "./plugin/index.js";

async function withSandbox<T>(fn: (repoRoot: string, outRoot: string) => Promise<T>): Promise<T> {
  const repoRoot = mkdtempSync(join(tmpdir(), "harness-kit-build-"));
  writeFileSync(
    join(repoRoot, "harness.yaml"),
    "marketplace: build-test\nowner:\n  name: harness-kit-tests\nvendors:\n  - claude\n",
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

test("build emits SKILL.md into the repo build dir", async () => {
  await withSandbox(async (repoRoot, outRoot) => {
    await build({ repoRoot, silent: true });
    ok(existsSync(join(outRoot, "claude/plugins/foo/skills/bar/SKILL.md")));
  });
});

test("build removes stale build output before building", async () => {
  await withSandbox(async (repoRoot, outRoot) => {
    const stalePath = join(outRoot, "claude/plugins/old/skills/gone/SKILL.md");
    mkdirSync(join(outRoot, "claude/plugins/old/skills/gone"), { recursive: true });
    writeFileSync(stalePath, "stale\n");
    await build({ repoRoot, silent: true });
    ok(!existsSync(stalePath), "stale plugin should be removed");
    ok(existsSync(join(outRoot, "claude/plugins/foo/skills/bar/SKILL.md")));
  });
});

test("build writes a success line to stdout when not silent", async () => {
  await withSandbox(async (repoRoot, outRoot) => {
    const original = console.log;
    const lines: string[] = [];
    console.log = (msg: string) => lines.push(msg);
    try {
      await build({ repoRoot });
    } finally {
      console.log = original;
    }
    const joined = lines.join("\n");
    match(joined, /built →/);
    ok(joined.includes(outRoot));
  });
});
