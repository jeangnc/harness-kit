import { test } from "node:test";
import { deepEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { layoutAt, loadCatalogOrThrow, type ResolvedPlugin } from "../layout/index.js";
import { AGENT_PLUGINS_SCHEMA } from "../plugin/index.js";

import { vendorWorkspace } from "./trees.js";

const SCOPE = { registeredVendors: ["claude", "codex"] } as const;

async function withPlugin(
  files: readonly string[],
  fn: (plugins: readonly ResolvedPlugin[]) => Promise<void>,
): Promise<void> {
  const repoRoot = mkdtempSync(join(tmpdir(), "harness-trees-"));
  try {
    writeFileSync(
      join(repoRoot, "harness.yaml"),
      "marketplace: m\nowner:\n  name: t\nvendors: [claude, codex]\n",
    );
    const pluginDir = join(repoRoot, "plugins/foo");
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(
      join(pluginDir, "plugin.json"),
      JSON.stringify({
        $schema: AGENT_PLUGINS_SCHEMA,
        name: "foo",
        version: "1.0.0",
        description: "t",
      }),
    );
    for (const rel of files) {
      mkdirSync(join(pluginDir, dirname(rel)), { recursive: true });
      writeFileSync(join(pluginDir, rel), `${rel}\n`);
    }
    await fn((await loadCatalogOrThrow(layoutAt(repoRoot))).plugins);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
}

test("vendorWorkspace indexes skills with SKILL.md, commands, and agents per plugin", async () => {
  await withPlugin(
    ["skills/bar/SKILL.md", "skills/empty/notes.md", "commands/go.md", "agents/helper.md"],
    async (plugins) => {
      const { localIds } = await vendorWorkspace(
        { plugins, namedRoots: {} },
        { ...SCOPE, vendor: "claude" },
      );
      deepEqual([...localIds.skills], ["foo:bar"]);
      deepEqual([...localIds.commands], ["foo:go"]);
      deepEqual([...localIds.agents], ["foo:helper"]);
    },
  );
});

test("vendorWorkspace indexes an overlay-only skill for its vendor alone", async () => {
  await withPlugin(["codex/skills/bar/SKILL.md"], async (plugins) => {
    const workspaceFor = async (vendor: string) =>
      vendorWorkspace({ plugins, namedRoots: {} }, { ...SCOPE, vendor });
    deepEqual([...(await workspaceFor("codex")).localIds.skills], ["foo:bar"]);
    deepEqual([...(await workspaceFor("claude")).localIds.skills], []);
  });
});
