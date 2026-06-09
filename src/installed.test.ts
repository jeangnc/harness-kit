import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  defaultSources,
  discoverInstalled,
  indexInstalled,
  localSources,
  mergeArtifacts,
  type InstalledArtifacts,
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

test("discoverInstalled tags skills with the source's marketplace override when set", async () => {
  await withInstalledSourceFixture(async (root) => {
    // A local dist layout: plugin dir directly under root, no marketplace dir between.
    const pluginRoot = join(root, "plugin-x");
    mkdirSync(join(pluginRoot, "skills", "s"), { recursive: true });
    mkdirSync(join(pluginRoot, ".claude-plugin"), { recursive: true });
    writeFileSync(
      join(pluginRoot, ".claude-plugin/plugin.json"),
      JSON.stringify({ name: "plugin-x", version: "1.0.0" }),
    );
    writeFileSync(
      join(pluginRoot, "skills", "s", "SKILL.md"),
      `---\nname: s\ndescription: x\n---\n\nbody\n`,
    );
    const [skill] = (
      await discoverInstalled([
        {
          name: "claude",
          root,
          manifestRelativePath: ".claude-plugin/plugin.json",
          marketplace: "market-a",
        },
      ])
    ).skills;
    assert.ok(skill);
    assert.equal(skill.plugin, "plugin-x");
    assert.equal(
      skill.marketplace,
      "market-a",
      "marketplace override should win over the empty directory-derived value",
    );
  });
});

test("localSources reads the marketplace name from the dist marketplace manifest", async () => {
  await withInstalledSourceFixture(async (distRoot) => {
    const vendor = makeFakeVendor("claude");
    mkdirSync(join(distRoot, "claude/.claude-plugin"), { recursive: true });
    writeFileSync(
      join(distRoot, vendor.marketplaceManifestPath),
      JSON.stringify({ name: "market-a" }),
    );
    const sources = await localSources(distRoot, [vendor]);
    assert.equal(sources.length, 1);
    const [source] = sources;
    assert.ok(source);
    assert.equal(source.name, "claude");
    assert.equal(source.marketplace, "market-a");
    assert.equal(source.root, join(distRoot, "claude", "plugins"));
  });
});

test("localSources skips a vendor whose dist marketplace manifest is absent", async () => {
  await withInstalledSourceFixture(async (distRoot) => {
    const vendor = makeFakeVendor("claude");
    const sources = await localSources(distRoot, [vendor]);
    assert.deepEqual(sources, []);
  });
});

test("mergeArtifacts lets the overlay win on a colliding plugin:skill id", () => {
  const base: InstalledArtifacts = {
    skills: [
      {
        source: "claude",
        marketplace: "market-a",
        plugin: "plugin-x",
        skill: "old",
        path: "/cache/old",
      },
      {
        source: "claude",
        marketplace: "market-a",
        plugin: "plugin-x",
        skill: "keep",
        path: "/cache/keep",
      },
    ],
    commands: [],
    agents: [],
  };
  const overlay: InstalledArtifacts = {
    skills: [
      {
        source: "claude",
        marketplace: "market-a",
        plugin: "plugin-x",
        skill: "old",
        path: "/dist/old",
      },
      {
        source: "claude",
        marketplace: "market-a",
        plugin: "plugin-x",
        skill: "new",
        path: "/dist/new",
      },
    ],
    commands: [],
    agents: [],
  };
  const merged = mergeArtifacts(base, overlay);
  const byId = new Map(merged.skills.map((s) => [`${s.plugin}:${s.skill}`, s]));
  assert.equal(byId.get("plugin-x:old")?.path, "/dist/old", "overlay wins on collision");
  assert.equal(byId.get("plugin-x:keep")?.path, "/cache/keep", "base-only entry survives");
  assert.equal(byId.get("plugin-x:new")?.path, "/dist/new", "overlay-only entry is added");
  assert.equal(merged.skills.length, 3, "colliding id is not duplicated");
});
