import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  defaultSources,
  discoverInstalled,
  indexInstalled,
  type PluginSource,
} from "./installed.js";
import { makeFakeVendor } from "./vendor/fakeVendor.testutil.js";

async function withInstalledSourceFixture<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "harness-kit-sources-"));
  return fn(root).finally(() => rmSync(root, { recursive: true, force: true }));
}

interface FlatSkillSpec {
  readonly layout: "flat";
  readonly marketplace: string;
  readonly plugin: string;
  readonly skill: string;
}

interface VersionedSkillSpec {
  readonly layout: "versioned";
  readonly marketplace: string;
  readonly plugin: string;
  readonly version: string;
  readonly skill: string;
}

type SkillSpec = FlatSkillSpec | VersionedSkillSpec;

function pluginRootSegments(spec: SkillSpec): readonly string[] {
  return spec.layout === "flat"
    ? [spec.marketplace, spec.plugin]
    : [spec.marketplace, spec.plugin, spec.version];
}

function placeSkill(root: string, spec: SkillSpec): string {
  const pluginRoot = join(root, ...pluginRootSegments(spec));
  const skillDir = join(pluginRoot, "skills", spec.skill);
  mkdirSync(skillDir, { recursive: true });
  mkdirSync(join(pluginRoot, ".claude-plugin"), { recursive: true });
  writeFileSync(
    join(pluginRoot, ".claude-plugin/plugin.json"),
    JSON.stringify({ name: spec.plugin, version: "version" in spec ? spec.version : "1.0.0" }),
  );
  writeFileSync(
    join(skillDir, "SKILL.md"),
    `---\nname: ${spec.skill}\ndescription: x\n---\n\nbody\n`,
  );
  return join(skillDir, "SKILL.md");
}

test("discoverInstalled finds skills in a flat <marketplace>/<plugin>/skills/<skill>/SKILL.md layout", async () => {
  await withInstalledSourceFixture(async (root) => {
    placeSkill(root, {
      layout: "flat",
      marketplace: "market-a",
      plugin: "plugin-x",
      skill: "skill-1",
    });
    placeSkill(root, {
      layout: "flat",
      marketplace: "market-a",
      plugin: "plugin-x",
      skill: "skill-2",
    });
    placeSkill(root, {
      layout: "flat",
      marketplace: "market-a",
      plugin: "plugin-y",
      skill: "lone",
    });
    const result = (
      await discoverInstalled([
        { name: "claude", root, manifestRelativePath: ".claude-plugin/plugin.json" },
      ])
    ).skills;
    const ids = result.map((s) => `${s.plugin}:${s.skill}`).sort();
    assert.deepEqual(ids, ["plugin-x:skill-1", "plugin-x:skill-2", "plugin-y:lone"]);
  });
});

test("discoverInstalled finds skills in a versioned <marketplace>/<plugin>/<version>/skills/<skill>/SKILL.md layout", async () => {
  await withInstalledSourceFixture(async (root) => {
    placeSkill(root, {
      layout: "versioned",
      marketplace: "market-b",
      plugin: "plugin-z",
      version: "1.0.0",
      skill: "main",
    });
    placeSkill(root, {
      layout: "versioned",
      marketplace: "market-b",
      plugin: "plugin-z",
      version: "1.0.0",
      skill: "helper",
    });
    const result = (
      await discoverInstalled([
        { name: "codex", root, manifestRelativePath: ".claude-plugin/plugin.json" },
      ])
    ).skills;
    const ids = result.map((s) => `${s.plugin}:${s.skill}`).sort();
    assert.deepEqual(ids, ["plugin-z:helper", "plugin-z:main"]);
  });
});

test("discoverInstalled tags each skill with its source name", async () => {
  await withInstalledSourceFixture(async (root) => {
    const skillFile = placeSkill(root, {
      layout: "flat",
      marketplace: "m",
      plugin: "p",
      skill: "s",
    });
    const [skill] = (
      await discoverInstalled([
        { name: "claude", root, manifestRelativePath: ".claude-plugin/plugin.json" },
      ])
    ).skills;
    assert.ok(skill);
    assert.equal(skill.source, "claude");
    assert.equal(skill.plugin, "p");
    assert.equal(skill.skill, "s");
    assert.equal(skill.path, skillFile);
  });
});

test("discoverInstalled tags each skill with its marketplace in a flat layout", async () => {
  await withInstalledSourceFixture(async (root) => {
    placeSkill(root, { layout: "flat", marketplace: "market-a", plugin: "p", skill: "s" });
    const [skill] = (
      await discoverInstalled([
        { name: "claude", root, manifestRelativePath: ".claude-plugin/plugin.json" },
      ])
    ).skills;
    assert.ok(skill);
    assert.equal(skill.marketplace, "market-a");
  });
});

test("discoverInstalled tags each skill with its marketplace in a versioned layout", async () => {
  await withInstalledSourceFixture(async (root) => {
    placeSkill(root, {
      layout: "versioned",
      marketplace: "market-b",
      plugin: "p",
      version: "1.0.0",
      skill: "s",
    });
    const [skill] = (
      await discoverInstalled([
        { name: "claude", root, manifestRelativePath: ".claude-plugin/plugin.json" },
      ])
    ).skills;
    assert.ok(skill);
    assert.equal(skill.marketplace, "market-b");
  });
});

test("discoverInstalled distinguishes the same plugin:skill across two marketplaces", async () => {
  await withInstalledSourceFixture(async (root) => {
    placeSkill(root, { layout: "flat", marketplace: "market-a", plugin: "plugin-x", skill: "s" });
    placeSkill(root, { layout: "flat", marketplace: "market-b", plugin: "plugin-x", skill: "s" });
    const skills = (
      await discoverInstalled([
        { name: "claude", root, manifestRelativePath: ".claude-plugin/plugin.json" },
      ])
    ).skills;
    const marketplaces = skills.map((s) => s.marketplace).sort();
    assert.deepEqual(marketplaces, ["market-a", "market-b"]);
  });
});

test("discoverInstalled returns empty when source root does not exist", async () => {
  const result = (
    await discoverInstalled([
      {
        name: "any",
        root: "/this/path/definitely/does/not/exist",
        manifestRelativePath: ".any-plugin/plugin.json",
      },
    ])
  ).skills;
  assert.deepEqual(result, []);
});

test("discoverInstalled returns empty when source root exists but has no skills", async () => {
  await withInstalledSourceFixture(async (root) => {
    const result = (
      await discoverInstalled([
        { name: "claude", root, manifestRelativePath: ".claude-plugin/plugin.json" },
      ])
    ).skills;
    assert.deepEqual(result, []);
  });
});

test("discoverInstalled aggregates skills across multiple sources", async () => {
  await withInstalledSourceFixture(async (claudeRoot) => {
    await withInstalledSourceFixture(async (codexRoot) => {
      placeSkill(claudeRoot, { layout: "flat", marketplace: "m", plugin: "shared", skill: "main" });
      placeSkill(codexRoot, {
        layout: "versioned",
        marketplace: "m",
        plugin: "shared",
        version: "1.0.0",
        skill: "main",
      });
      placeSkill(codexRoot, {
        layout: "versioned",
        marketplace: "m",
        plugin: "codex-only",
        version: "1.0.0",
        skill: "exclusive",
      });
      const result = (
        await discoverInstalled([
          { name: "claude", root: claudeRoot, manifestRelativePath: ".claude-plugin/plugin.json" },
          { name: "codex", root: codexRoot, manifestRelativePath: ".claude-plugin/plugin.json" },
        ])
      ).skills;
      const ids = result.map((s) => `${s.source}/${s.plugin}:${s.skill}`).sort();
      assert.deepEqual(ids, [
        "claude/shared:main",
        "codex/codex-only:exclusive",
        "codex/shared:main",
      ]);
    });
  });
});

test("discoverInstalled skips symlinked directories to avoid loops", async () => {
  await withInstalledSourceFixture(async (root) => {
    placeSkill(root, { layout: "flat", marketplace: "m", plugin: "p", skill: "real" });
    symlinkSync(join(root, "m"), join(root, "loop"));
    const result = (
      await discoverInstalled([
        { name: "claude", root, manifestRelativePath: ".claude-plugin/plugin.json" },
      ])
    ).skills;
    const ids = result.map((s) => `${s.plugin}:${s.skill}`);
    assert.deepEqual(ids, ["p:real"]);
  });
});

test("indexInstalled groups installed skills by <plugin>:<skill> id", async () => {
  await withInstalledSourceFixture(async (root) => {
    placeSkill(root, {
      layout: "flat",
      marketplace: "market-a",
      plugin: "plugin-x",
      skill: "skill-1",
    });
    placeSkill(root, {
      layout: "flat",
      marketplace: "market-b",
      plugin: "plugin-x",
      skill: "skill-1",
    });
    const artifacts = await discoverInstalled([
      { name: "claude", root, manifestRelativePath: ".claude-plugin/plugin.json" },
    ]);
    const index = indexInstalled(artifacts).skills;
    assert.equal(index.get("plugin-x:skill-1")?.length, 2);
    assert.equal(index.has("plugin-x:other"), false);
  });
});

test("defaultSources derives one source per supplied vendor", () => {
  const fakeVendors = [
    makeFakeVendor("alpha", { home: "/tmp/alpha-home" }),
    makeFakeVendor("beta", { home: "/tmp/beta-home" }),
  ];
  const sources = defaultSources(fakeVendors);
  assert.deepEqual(
    sources.map((s: PluginSource) => ({
      name: s.name,
      root: s.root,
      manifestRelativePath: s.manifestRelativePath,
    })),
    [
      {
        name: "alpha",
        root: "/tmp/alpha-home/plugins/cache",
        manifestRelativePath: ".alpha-plugin/plugin.json",
      },
      {
        name: "beta",
        root: "/tmp/beta-home/plugins/cache",
        manifestRelativePath: ".beta-plugin/plugin.json",
      },
    ],
  );
});

test("defaultSources falls back to built-in vendors when none are supplied", () => {
  const sources = defaultSources();
  assert.ok(sources.length > 0, "expected at least one built-in vendor");
  for (const source of sources) {
    assert.ok(source.root.endsWith("/plugins/cache"), "root should end with plugins/cache");
    assert.ok(source.manifestRelativePath.endsWith("/plugin.json"));
  }
});
