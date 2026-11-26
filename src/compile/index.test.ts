import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  chmodSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { compilePlugins } from "./index.js";
import { claudeVendor } from "../vendors/claude/index.js";
import type { PluginSource } from "../installed.js";
import { layoutAt, type Layout } from "../layout/index.js";
import { AGENT_PLUGINS_SCHEMA } from "../plugin/index.js";

const vendors = [claudeVendor];

const fixturesRoot = fileURLToPath(new URL("./__fixtures__", import.meta.url));
const goodRoot = join(fixturesRoot, "good");
const companionRenderRoot = join(fixturesRoot, "companionRender");
const withPluginRoot = join(fixturesRoot, "withPlugin");
const mdSourceRoot = join(fixturesRoot, "mdSource");

const HARNESS_YAML = `marketplace: test-marketplace
owner:
  name: harness-kit-tests
vendors: [claude]
`;

function testLayout(repoRoot: string, distRoot: string): Layout {
  return { ...layoutAt(repoRoot), buildDir: distRoot };
}

async function withTempDist<T>(fn: (dist: string) => Promise<T>): Promise<T> {
  const dist = mkdtempSync(join(tmpdir(), "harness-kit-test-"));
  return fn(dist).finally(() => rmSync(dist, { recursive: true, force: true }));
}

function pluginManifest(
  name: string,
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    $schema: AGENT_PLUGINS_SCHEMA,
    name,
    version: "0.0.1",
    description: "test fixture plugin",
    ...overrides,
  };
}

function writePluginManifest(
  repoRoot: string,
  folderName: string,
  manifest: Readonly<Record<string, unknown>>,
): void {
  const pluginDir = join(repoRoot, "plugins", folderName);
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(join(pluginDir, "plugin.json"), JSON.stringify(manifest, null, 2) + "\n");
}

function ensurePlugin(repoRoot: string, pluginName: string): void {
  const harnessPath = join(repoRoot, "harness.yaml");
  if (!existsSync(harnessPath)) {
    mkdirSync(repoRoot, { recursive: true });
    writeFileSync(harnessPath, HARNESS_YAML);
  }
  if (!existsSync(join(repoRoot, "plugins", pluginName, "plugin.json"))) {
    writePluginManifest(repoRoot, pluginName, pluginManifest(pluginName));
  }
}

async function withRepo<T>(fn: (repoRoot: string, distRoot: string) => Promise<T>): Promise<T> {
  const repoRoot = mkdtempSync(join(tmpdir(), "harness-kit-repo-"));
  const distRoot = mkdtempSync(join(tmpdir(), "harness-kit-dist-"));
  return fn(repoRoot, distRoot).finally(() => {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(distRoot, { recursive: true, force: true });
  });
}

function skillMarkdown(name: string, body: string): string {
  return `---\nname: ${name}\ndescription: fixture skill\n---\n\n${body}`;
}

interface SkillFixtureOptions {
  readonly skillMd: string;
  readonly companionFiles?: Readonly<Record<string, string>>;
}

async function withSkillFixture<T>(
  options: SkillFixtureOptions,
  fn: (repoRoot: string, distRoot: string) => Promise<T>,
): Promise<T> {
  return withRepo(async (repoRoot, distRoot) => {
    const skillDir = join(repoRoot, "plugins/foo/skills/bar");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), options.skillMd);
    for (const [name, content] of Object.entries(options.companionFiles ?? {})) {
      writeFileSync(join(skillDir, name), content);
    }
    ensurePlugin(repoRoot, "foo");
    return fn(repoRoot, distRoot);
  });
}

interface PluginFixtureOptions {
  readonly folderName?: string;
  readonly manifest?: Readonly<Record<string, unknown>>;
  readonly extraFiles?: Readonly<Record<string, string>>;
}

async function withPluginFixture<T>(
  options: PluginFixtureOptions,
  fn: (repoRoot: string, distRoot: string) => Promise<T>,
): Promise<T> {
  return withRepo(async (repoRoot, distRoot) => {
    const folderName = options.folderName ?? "foo";
    writeFileSync(join(repoRoot, "harness.yaml"), HARNESS_YAML);
    writePluginManifest(repoRoot, folderName, options.manifest ?? pluginManifest(folderName));
    for (const [relPath, content] of Object.entries(options.extraFiles ?? {})) {
      const target = join(repoRoot, "plugins", folderName, relPath);
      mkdirSync(join(target, ".."), { recursive: true });
      writeFileSync(target, content);
    }
    return fn(repoRoot, distRoot);
  });
}

function makeStubSkill(repoRoot: string, plugin: string, name: string): void {
  const dir = join(repoRoot, "plugins", plugin, "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: stub\n---\n\n# ${name}\n`);
  ensurePlugin(repoRoot, plugin);
}

function makeStubCommand(repoRoot: string, plugin: string, name: string): void {
  const dir = join(repoRoot, "plugins", plugin, "commands");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${name}.md`),
    `---\nname: ${name}\ndescription: stub command\n---\n\n# ${name}\n`,
  );
  ensurePlugin(repoRoot, plugin);
}

function makeStubAgent(repoRoot: string, plugin: string, name: string): void {
  const dir = join(repoRoot, "plugins", plugin, "agents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${name}.md`),
    `---\nname: ${name}\ndescription: stub agent\n---\n\n# ${name}\n`,
  );
  ensurePlugin(repoRoot, plugin);
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

interface InstalledArtifact {
  readonly plugin: string;
  readonly skill?: string;
  readonly command?: string;
  readonly agent?: string;
}

async function withInstalledSources<T>(
  installed: readonly InstalledArtifact[],
  fn: (sources: readonly PluginSource[]) => Promise<T>,
): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "harness-kit-installed-"));
  for (const item of installed) {
    const pluginRoot = join(root, "marketplace", item.plugin);
    mkdirSync(join(pluginRoot, ".claude-plugin"), { recursive: true });
    writeFileSync(
      join(pluginRoot, ".claude-plugin/plugin.json"),
      JSON.stringify({ name: item.plugin, version: "1.0.0" }),
    );
    if (item.skill) {
      const skillDir = join(pluginRoot, "skills", item.skill);
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(
        join(skillDir, "SKILL.md"),
        `---\nname: ${item.skill}\ndescription: x\n---\n\nbody\n`,
      );
    }
    if (item.command) {
      const dir = join(pluginRoot, "commands");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, `${item.command}.md`),
        `---\nname: ${item.command}\ndescription: x\n---\n\nbody\n`,
      );
    }
    if (item.agent) {
      const dir = join(pluginRoot, "agents");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, `${item.agent}.md`),
        `---\nname: ${item.agent}\ndescription: x\n---\n\nbody\n`,
      );
    }
  }
  return fn([{ name: "claude", root, manifestRelativePath: ".claude-plugin/plugin.json" }]).finally(
    () => rmSync(root, { recursive: true, force: true }),
  );
}

test("compile emits SKILL.md with frontmatter and body for a SKILL.md source", async () => {
  await withTempDist(async (dist) => {
    await compilePlugins({ layout: testLayout(goodRoot, dist), vendors });

    const skillPath = join(dist, "claude/plugins/foo/skills/bar/SKILL.md");
    assert.ok(existsSync(skillPath), `expected ${skillPath} to exist`);

    const content = readFileSync(skillPath, "utf8");
    assert.match(
      content,
      /^---\nname: bar\ndescription: A tiny test skill that asserts the compile pipeline works\.\n---\n\n# Bar\n\nThis is the body\.\n$/,
    );
  });
});

test("compile does not copy the source plugin.json verbatim into the vendor tree", async () => {
  await withTempDist(async (dist) => {
    await compilePlugins({ layout: testLayout(goodRoot, dist), vendors });

    const stray = join(dist, "claude/plugins/foo/plugin.json");
    assert.ok(!existsSync(stray), `did not expect ${stray} to exist`);
  });
});

test("compile names the claude catalog after the harness.yaml marketplace", async () => {
  await withTempDist(async (dist) => {
    await compilePlugins({ layout: testLayout(goodRoot, dist), vendors });

    const catalog = readJson(join(dist, "claude/.claude-plugin/marketplace.json"));
    assert.equal(catalog["name"], "test-marketplace");
    assert.deepEqual(catalog["owner"], { name: "harness-kit-tests" });
  });
});

test("compile lists each discovered plugin in the claude catalog with its source and description", async () => {
  await withTempDist(async (dist) => {
    await compilePlugins({ layout: testLayout(goodRoot, dist), vendors });

    const catalog = readJson(join(dist, "claude/.claude-plugin/marketplace.json"));
    assert.deepEqual(catalog["plugins"], [
      { name: "foo", source: "./plugins/foo", description: "Test fixture plugin" },
    ]);
  });
});

test("compile ignores top-level files outside plugins/", async () => {
  await withTempDist(async (dist) => {
    await compilePlugins({ layout: testLayout(goodRoot, dist), vendors });

    const stray = join(dist, "README.md");
    assert.ok(!existsSync(stray), `did not expect ${stray} to exist`);
  });
});

test("compile renders frontmatter companions into the {{companions}} placeholder", async () => {
  await withTempDist(async (dist) => {
    await compilePlugins({ layout: testLayout(companionRenderRoot, dist), vendors });

    const skillPath = join(dist, "claude/plugins/foo/skills/bar/SKILL.md");
    const content = readFileSync(skillPath, "utf8");

    assert.ok(
      content.includes(
        "## Companion files (read on demand)\n\n- `a.md` — First companion.\n- `b.md` — Second companion.",
      ),
      `expected rendered companions section, got:\n${content}`,
    );
    assert.ok(
      !content.includes("{{companions}}"),
      `dist should not contain the raw token, got:\n${content}`,
    );
  });
});

test("compile substitutes {{skill:...}} for a discovered local skill", async () => {
  await withSkillFixture(
    {
      skillMd: skillMarkdown("bar", "see {{skill:dev-tools:ruby}} for ruby idioms"),
    },
    async (repoRoot, distRoot) => {
      makeStubSkill(repoRoot, "dev-tools", "ruby");
      await compilePlugins({ layout: testLayout(repoRoot, distRoot), vendors });
      const out = readFileSync(join(distRoot, "claude/plugins/foo/skills/bar/SKILL.md"), "utf8");
      assert.match(out, /see `dev-tools:ruby` for ruby idioms/);
    },
  );
});

test("compile warns but still renders when {{skill:...}} resolves to neither a local nor an installed skill", async () => {
  await withSkillFixture(
    {
      skillMd: skillMarkdown("bar", "see {{skill:superpowers:nonexistent}}"),
    },
    async (repoRoot, distRoot) => {
      const warnings: string[] = [];
      await compilePlugins({
        layout: testLayout(repoRoot, distRoot),
        vendors,
        onWarnings: (_file, ws) => warnings.push(...ws),
      });
      const out = readFileSync(join(distRoot, "claude/plugins/foo/skills/bar/SKILL.md"), "utf8");
      assert.match(out, /see `superpowers:nonexistent`/);
      assert.ok(
        warnings.some((w) => w.includes("superpowers:nonexistent")),
        `expected an unresolved-ref warning, got:\n${warnings.join("\n")}`,
      );
    },
  );
});

test("compile fails when {{skill:...}} value does not have <plugin>:<skill> shape", async () => {
  await withSkillFixture(
    {
      skillMd: skillMarkdown("bar", "see {{skill:lonelyid}} for nothing"),
    },
    async (repoRoot, distRoot) => {
      await assert.rejects(
        compilePlugins({ layout: testLayout(repoRoot, distRoot), vendors }),
        /<plugin>:<skill>/,
      );
    },
  );
});

test("compile fails when companions are declared but {{companions}} token is absent", async () => {
  const skillMd = `---
name: bar
description: fixture skill with companions
companions:
  - file: a.md
    summary: First.
---

# Bar

No token here.
`;
  await withSkillFixture(
    { skillMd, companionFiles: { "a.md": "# A\n" } },
    async (repoRoot, distRoot) => {
      await assert.rejects(
        compilePlugins({ layout: testLayout(repoRoot, distRoot), vendors }),
        /\{\{companions\}\}/,
      );
    },
  );
});

test("compile fails when {{companions}} is present but no companions are declared", async () => {
  await withSkillFixture(
    {
      skillMd: skillMarkdown("bar", "# Bar\n\n{{companions}}\n"),
    },
    async (repoRoot, distRoot) => {
      await assert.rejects(
        compilePlugins({ layout: testLayout(repoRoot, distRoot), vendors }),
        /no companions are declared/,
      );
    },
  );
});

test("compile fails on unknown placeholder prefix", async () => {
  await withSkillFixture(
    {
      skillMd: skillMarkdown("bar", "# Bar\n\n{{nope:foo}}\n"),
    },
    async (repoRoot, distRoot) => {
      await assert.rejects(
        compilePlugins({ layout: testLayout(repoRoot, distRoot), vendors }),
        /unknown placeholder prefix "nope"/,
      );
    },
  );
});

test("compile fails when a SKILL.md description spans multiple lines", async () => {
  const skillMd = `---\nname: bar\ndescription: "line one\\nline two"\n---\n\n# Bar\n`;
  await withSkillFixture({ skillMd }, async (repoRoot, distRoot) => {
    await assert.rejects(
      compilePlugins({ layout: testLayout(repoRoot, distRoot), vendors }),
      /description/i,
    );
  });
});

test("compile emits the claude plugin manifest with Agent Plugins fields preserved", async () => {
  await withTempDist(async (dist) => {
    await compilePlugins({ layout: testLayout(withPluginRoot, dist), vendors });

    const manifest = readJson(join(dist, "claude/plugins/foo/.claude-plugin/plugin.json"));
    assert.equal(manifest["name"], "foo");
    assert.equal(manifest["version"], "1.2.3");
    assert.equal(manifest["description"], "demo plugin used by withPlugin fixture");
    assert.equal(manifest["license"], "MIT");
    assert.deepEqual(manifest["keywords"], ["fixture", "demo"]);
  });
});

test("compile merges extensions.claude into the top level of the claude plugin manifest", async () => {
  await withTempDist(async (dist) => {
    await compilePlugins({ layout: testLayout(withPluginRoot, dist), vendors });

    const manifest = readJson(join(dist, "claude/plugins/foo/.claude-plugin/plugin.json"));
    assert.deepEqual(manifest["dependencies"], ["bar-core"]);
  });
});

test("compile drops $schema and extensions from the claude plugin manifest", async () => {
  await withTempDist(async (dist) => {
    await compilePlugins({ layout: testLayout(withPluginRoot, dist), vendors });

    const manifest = readJson(join(dist, "claude/plugins/foo/.claude-plugin/plugin.json"));
    assert.equal("$schema" in manifest, false);
    assert.equal("extensions" in manifest, false);
  });
});

test("compile fails when plugin.json name does not match the plugin folder", async () => {
  await withPluginFixture(
    { folderName: "foo", manifest: pluginManifest("wrong") },
    async (repoRoot, distRoot) => {
      await assert.rejects(
        compilePlugins({ layout: testLayout(repoRoot, distRoot), vendors }),
        /name "wrong" does not match folder "foo"/,
      );
    },
  );
});

test("compile fails when a plugins/ folder has no plugin.json", async () => {
  await withRepo(async (repoRoot, distRoot) => {
    writeFileSync(join(repoRoot, "harness.yaml"), HARNESS_YAML);
    mkdirSync(join(repoRoot, "plugins/foo/skills"), { recursive: true });
    await assert.rejects(
      compilePlugins({ layout: testLayout(repoRoot, distRoot), vendors }),
      /expected plugin\.json in plugin folder .*plugins\/foo/,
    );
  });
});

test("compile fails when plugin.json declares an unknown top-level key", async () => {
  await withPluginFixture(
    { manifest: pluginManifest("foo", { category: "development" }) },
    async (repoRoot, distRoot) => {
      await assert.rejects(
        compilePlugins({ layout: testLayout(repoRoot, distRoot), vendors }),
        /plugin manifest at .*plugin\.json is invalid/,
      );
    },
  );
});

test("compile fails when plugin.json omits $schema", async () => {
  const { $schema: _schema, ...withoutSchema } = pluginManifest("foo");
  await withPluginFixture({ manifest: withoutSchema }, async (repoRoot, distRoot) => {
    await assert.rejects(
      compilePlugins({ layout: testLayout(repoRoot, distRoot), vendors }),
      /\$schema/,
    );
  });
});

test("compile substitutes {{ref:path}} for a file that exists relative to the skill", async () => {
  await withPluginFixture(
    {
      extraFiles: {
        "shared/linear-ids.md": "# Linear IDs\n",
        "skills/bar/SKILL.md": skillMarkdown(
          "bar",
          "see {{ref:../../shared/linear-ids.md}} for the map\n",
        ),
      },
    },
    async (repoRoot, distRoot) => {
      await compilePlugins({ layout: testLayout(repoRoot, distRoot), vendors });
      const out = readFileSync(join(distRoot, "claude/plugins/foo/skills/bar/SKILL.md"), "utf8");
      assert.match(out, /see `\.\.\/\.\.\/shared\/linear-ids\.md` for the map/);
    },
  );
});

test("compile fails when {{ref:path}} resolves to a missing file", async () => {
  await withPluginFixture(
    {
      extraFiles: {
        "skills/bar/SKILL.md": skillMarkdown("bar", "see {{ref:../../shared/missing.md}}\n"),
      },
    },
    async (repoRoot, distRoot) => {
      await assert.rejects(
        compilePlugins({ layout: testLayout(repoRoot, distRoot), vendors }),
        /ref.*missing\.md.*not found/,
      );
    },
  );
});

test("compile preserves the executable bit on hook scripts copied through dist", async () => {
  await withPluginFixture(
    {
      extraFiles: { "hooks/example.sh": "#!/usr/bin/env bash\necho hi\n" },
    },
    async (repoRoot, distRoot) => {
      chmodSync(join(repoRoot, "plugins/foo/hooks/example.sh"), 0o755);
      await compilePlugins({ layout: testLayout(repoRoot, distRoot), vendors });

      const distScript = join(distRoot, "claude/plugins/foo/hooks/example.sh");
      assert.ok(existsSync(distScript), `expected ${distScript} to exist`);
      const mode = statSync(distScript).mode & 0o777;
      assert.equal(
        mode,
        0o755,
        `expected mode 0755, got 0${mode.toString(8)} — copyFile lost the +x bit`,
      );
    },
  );
});

test("compile strips dot-prefixed directories from a plugin's source tree", async () => {
  await withPluginFixture(
    {
      extraFiles: {
        ".fragments/snippet.md": "build-time only\n",
      },
    },
    async (repoRoot, distRoot) => {
      await compilePlugins({ layout: testLayout(repoRoot, distRoot), vendors });
      const pluginDist = claudeVendor.pluginOutDir(distRoot, "foo");
      const stray = join(pluginDist, ".fragments/snippet.md");
      assert.ok(!existsSync(stray), `did not expect ${stray} to exist`);
      const strayDir = join(pluginDist, ".fragments");
      assert.ok(!existsSync(strayDir), `did not expect ${strayDir} to exist`);
    },
  );
});

test("compile keeps non-dot companion directories in a plugin's source tree", async () => {
  await withPluginFixture(
    {
      extraFiles: {
        "companions/runtime.md": "runtime data\n",
      },
    },
    async (repoRoot, distRoot) => {
      await compilePlugins({ layout: testLayout(repoRoot, distRoot), vendors });
      const pluginDist = claudeVendor.pluginOutDir(distRoot, "foo");
      const kept = join(pluginDist, "companions/runtime.md");
      assert.ok(existsSync(kept), `expected ${kept} to exist`);
    },
  );
});

test("compile emits dist SKILL.md from a plain SKILL.md source", async () => {
  const skillMd = `---
name: bar
description: plain markdown skill
---

# Bar
inline body
`;
  await withSkillFixture({ skillMd }, async (repoRoot, distRoot) => {
    await compilePlugins({ layout: testLayout(repoRoot, distRoot), vendors });
    const out = readFileSync(join(distRoot, "claude/plugins/foo/skills/bar/SKILL.md"), "utf8");
    assert.match(
      out,
      /^---\nname: bar\ndescription: plain markdown skill\n---\n\n# Bar\ninline body\n$/,
    );
  });
});

test("compile substitutes a cross-marketplace {{skill:...}} in a plain SKILL.md body", async () => {
  const skillMd = `---
name: bar
description: plain skill
---

see {{skill:superpowers:tdd}} for tdd
`;
  await withSkillFixture({ skillMd }, async (repoRoot, distRoot) => {
    await compilePlugins({ layout: testLayout(repoRoot, distRoot), vendors });
    const out = readFileSync(join(distRoot, "claude/plugins/foo/skills/bar/SKILL.md"), "utf8");
    assert.match(out, /see `superpowers:tdd` for tdd/);
    assert.ok(!out.includes("{{skill:"), "raw token should not survive in dist");
  });
});

test("compile renders companions declared in SKILL.md frontmatter", async () => {
  const skillMd = `---
name: bar
description: skill with companions in frontmatter
companions:
  - file: a.md
    summary: First companion.
  - file: b.md
    summary: Second companion.
---

# Bar

{{companions}}
`;
  await withSkillFixture(
    { skillMd, companionFiles: { "a.md": "# A\n", "b.md": "# B\n" } },
    async (repoRoot, distRoot) => {
      await compilePlugins({ layout: testLayout(repoRoot, distRoot), vendors });
      const out = readFileSync(join(distRoot, "claude/plugins/foo/skills/bar/SKILL.md"), "utf8");
      assert.ok(
        out.includes(
          "## Companion files (read on demand)\n\n- `a.md` — First companion.\n- `b.md` — Second companion.",
        ),
        `expected rendered companions section, got:\n${out}`,
      );
    },
  );
});

test("compile emits companions in dist frontmatter when declared", async () => {
  const skillMd = `---
name: bar
description: skill with companions
companions:
  - file: a.md
    summary: First.
---

# Bar

{{companions}}
`;
  await withSkillFixture(
    { skillMd, companionFiles: { "a.md": "# A\n" } },
    async (repoRoot, distRoot) => {
      await compilePlugins({ layout: testLayout(repoRoot, distRoot), vendors });
      const out = readFileSync(join(distRoot, "claude/plugins/foo/skills/bar/SKILL.md"), "utf8");
      const frontmatterMatch = /^---\n([\s\S]*?)\n---/.exec(out);
      assert.ok(frontmatterMatch, "dist file should have frontmatter");
      const fm = frontmatterMatch[1] ?? "";
      assert.match(fm, /companions:/);
      assert.match(fm, /file: a\.md/);
      assert.match(fm, /summary: First\./);
    },
  );
});

test("compile does not write the source SKILL.md as both rewritten skill and verbatim copy", async () => {
  const skillMd = `---\nname: bar\ndescription: x\n---\n\nsee {{skill:foo:bar}}\n`;
  await withSkillFixture({ skillMd }, async (repoRoot, distRoot) => {
    await compilePlugins({ layout: testLayout(repoRoot, distRoot), vendors });
    const out = readFileSync(join(distRoot, "claude/plugins/foo/skills/bar/SKILL.md"), "utf8");
    assert.ok(
      !out.includes("{{skill:"),
      `dist SKILL.md should be the rewritten version, got:\n${out}`,
    );
  });
});

test("compile renders {{skill:...}} from a plain SKILL.md to a skill in another local plugin", async () => {
  const skillMd = `---\nname: bar\ndescription: x\n---\n\nsee {{skill:dev-tools:ruby}}\n`;
  await withSkillFixture({ skillMd }, async (repoRoot, distRoot) => {
    makeStubSkill(repoRoot, "dev-tools", "ruby");
    await compilePlugins({ layout: testLayout(repoRoot, distRoot), vendors });
    const out = readFileSync(join(distRoot, "claude/plugins/foo/skills/bar/SKILL.md"), "utf8");
    assert.match(out, /see `dev-tools:ruby`/);
  });
});

test("compile discovers a SKILL.md skill as a local skill (visible to {{skill:...}} from elsewhere)", async () => {
  const skillMd = `---\nname: bar\ndescription: x\n---\n\nsee {{skill:other:peer}}\n`;
  await withSkillFixture({ skillMd }, async (repoRoot, distRoot) => {
    const peerDir = join(repoRoot, "plugins/other/skills/peer");
    mkdirSync(peerDir, { recursive: true });
    writeFileSync(join(peerDir, "SKILL.md"), `---\nname: peer\ndescription: peer\n---\n\n# Peer\n`);
    ensurePlugin(repoRoot, "other");
    await compilePlugins({ layout: testLayout(repoRoot, distRoot), vendors });
    const out = readFileSync(join(distRoot, "claude/plugins/foo/skills/bar/SKILL.md"), "utf8");
    assert.match(out, /see `other:peer`/);
  });
});

test("compile expands {{include:./path.md}} in a SKILL.md body", async () => {
  const skillMd = `---\nname: bar\ndescription: x\n---\n\nbefore\n{{include:./fragment.md}}\nafter\n`;
  await withSkillFixture(
    { skillMd, companionFiles: { "fragment.md": "INLINED-CONTENT\n" } },
    async (repoRoot, distRoot) => {
      await compilePlugins({ layout: testLayout(repoRoot, distRoot), vendors });
      const out = readFileSync(join(distRoot, "claude/plugins/foo/skills/bar/SKILL.md"), "utf8");
      assert.match(out, /before\nINLINED-CONTENT\nafter/);
      assert.ok(!out.includes("{{include:"), `raw include token survived in:\n${out}`);
    },
  );
});

test("compile resolves placeholders inside an included file against the host skill", async () => {
  const skillMd = `---\nname: bar\ndescription: x\n---\n\n{{include:./shared.md}}\n`;
  await withSkillFixture(
    { skillMd, companionFiles: { "shared.md": "see {{skill:foo:bar}} please\n" } },
    async (repoRoot, distRoot) => {
      await compilePlugins({ layout: testLayout(repoRoot, distRoot), vendors });
      const out = readFileSync(join(distRoot, "claude/plugins/foo/skills/bar/SKILL.md"), "utf8");
      assert.match(out, /see `foo:bar` please/);
    },
  );
});

test("compile fails on an include cycle", async () => {
  const skillMd = `---\nname: bar\ndescription: x\n---\n\n{{include:./a.md}}\n`;
  await withSkillFixture(
    {
      skillMd,
      companionFiles: { "a.md": "{{include:./b.md}}", "b.md": "{{include:./a.md}}" },
    },
    async (repoRoot, distRoot) => {
      await assert.rejects(
        compilePlugins({ layout: testLayout(repoRoot, distRoot), vendors }),
        /cycle/,
      );
    },
  );
});

test("compile inlines a #-anchored include from the repo root", async () => {
  const skillMd = `---\nname: bar\ndescription: x\n---\n\nx {{include:#shared/frag.md}} y\n`;
  await withSkillFixture({ skillMd }, async (repoRoot, distRoot) => {
    mkdirSync(join(repoRoot, "shared"), { recursive: true });
    writeFileSync(join(repoRoot, "shared/frag.md"), "FRAG");
    await compilePlugins({ layout: testLayout(repoRoot, distRoot), vendors });
    const out = readFileSync(join(distRoot, "claude/plugins/foo/skills/bar/SKILL.md"), "utf8");
    assert.match(out, /x FRAG y/);
  });
});

test("compile inlines a cross-skill include without emitting the fragment to dist", async () => {
  const skillMd = `---\nname: bar\ndescription: x\n---\n\nx {{include:../sibling/.fragments/frag.md}} y\n`;
  await withSkillFixture({ skillMd }, async (repoRoot, distRoot) => {
    const fragDir = join(repoRoot, "plugins/foo/skills/sibling/.fragments");
    mkdirSync(fragDir, { recursive: true });
    writeFileSync(join(fragDir, "frag.md"), "SHARED");
    await compilePlugins({ layout: testLayout(repoRoot, distRoot), vendors });
    const out = readFileSync(join(distRoot, "claude/plugins/foo/skills/bar/SKILL.md"), "utf8");
    assert.match(out, /x SHARED y/);
    const stray = join(distRoot, "claude/plugins/foo/skills/sibling/.fragments/frag.md");
    assert.ok(!existsSync(stray), `included fragment should not land in dist at ${stray}`);
  });
});

test("compile fails when an include target is missing", async () => {
  const skillMd = `---\nname: bar\ndescription: x\n---\n\n{{include:./ghost.md}}\n`;
  await withSkillFixture({ skillMd }, async (repoRoot, distRoot) => {
    await assert.rejects(
      compilePlugins({ layout: testLayout(repoRoot, distRoot), vendors }),
      /not found/,
    );
  });
});

test("compile does not copy included .md files into dist", async () => {
  const skillMd = `---\nname: bar\ndescription: x\n---\n\n{{include:./fragment.md}}\n`;
  await withSkillFixture(
    { skillMd, companionFiles: { "fragment.md": "inlined\n" } },
    async (repoRoot, distRoot) => {
      await compilePlugins({ layout: testLayout(repoRoot, distRoot), vendors });
      const stray = join(distRoot, "claude/plugins/foo/skills/bar/fragment.md");
      assert.ok(!existsSync(stray), `included file should not land in dist at ${stray}`);
    },
  );
});

test("compile leaves frontmatter untouched when {{include:...}} appears in body", async () => {
  const skillMd = `---\nname: bar\ndescription: untouched description\n---\n\n{{include:./fragment.md}}\n`;
  await withSkillFixture(
    { skillMd, companionFiles: { "fragment.md": "body content\n" } },
    async (repoRoot, distRoot) => {
      await compilePlugins({ layout: testLayout(repoRoot, distRoot), vendors });
      const out = readFileSync(join(distRoot, "claude/plugins/foo/skills/bar/SKILL.md"), "utf8");
      assert.match(out, /^---\nname: bar\ndescription: untouched description\n---\n\n/);
    },
  );
});

test("compile does not flag an included sibling as an undeclared companion", async () => {
  const skillMd = `---\nname: bar\ndescription: x\n---\n\n{{include:./fragment.md}}\n`;
  await withSkillFixture(
    { skillMd, companionFiles: { "fragment.md": "inlined\n" } },
    async (repoRoot, distRoot) => {
      await compilePlugins({ layout: testLayout(repoRoot, distRoot), vendors });
    },
  );
});

test("compile substitutes {{skill:...}} inside the frontmatter description", async () => {
  const skillMd = `---\nname: bar\ndescription: use {{skill:dev-tools:ruby}} instead\n---\n\n# Bar\n`;
  await withSkillFixture({ skillMd }, async (repoRoot, distRoot) => {
    makeStubSkill(repoRoot, "dev-tools", "ruby");
    await compilePlugins({ layout: testLayout(repoRoot, distRoot), vendors });
    const out = readFileSync(join(distRoot, "claude/plugins/foo/skills/bar/SKILL.md"), "utf8");
    assert.match(out, /description: use `dev-tools:ruby` instead/);
    assert.ok(!out.includes("{{skill:"), `raw token survived in frontmatter:\n${out}`);
  });
});

test("compile substitutes a cross-marketplace {{skill:...}} inside the frontmatter description", async () => {
  const skillMd = `---\nname: bar\ndescription: see {{skill:superpowers:tdd}} for details\n---\n\n# Bar\n`;
  await withSkillFixture({ skillMd }, async (repoRoot, distRoot) => {
    await compilePlugins({ layout: testLayout(repoRoot, distRoot), vendors });
    const out = readFileSync(join(distRoot, "claude/plugins/foo/skills/bar/SKILL.md"), "utf8");
    assert.match(out, /description: see `superpowers:tdd` for details/);
    assert.ok(!out.includes("{{skill:"), `raw token survived in frontmatter:\n${out}`);
  });
});

test("compile warns when a frontmatter description references a skill resolved nowhere", async () => {
  const skillMd = `---\nname: bar\ndescription: see {{skill:superpowers:ghost}}\n---\n\n# Bar\n`;
  await withSkillFixture({ skillMd }, async (repoRoot, distRoot) => {
    const warnings: string[] = [];
    await compilePlugins({
      layout: testLayout(repoRoot, distRoot),
      vendors,
      onWarnings: (_file, ws) => warnings.push(...ws),
    });
    const out = readFileSync(join(distRoot, "claude/plugins/foo/skills/bar/SKILL.md"), "utf8");
    assert.match(out, /description: see `superpowers:ghost`/);
    assert.ok(
      warnings.some((w) => w.includes("superpowers:ghost")),
      `expected an unresolved-ref warning, got:\n${warnings.join("\n")}`,
    );
  });
});

test("compile substitutes placeholders inside declared companion files", async () => {
  const skillMd = `---
name: bar
description: x
companions:
  - file: procedure.md
    summary: Step procedure.
---

# Bar

{{companions}}
`;
  await withSkillFixture(
    {
      skillMd,
      companionFiles: { "procedure.md": "see {{skill:superpowers:tdd}} for tdd\n" },
    },
    async (repoRoot, distRoot) => {
      await compilePlugins({ layout: testLayout(repoRoot, distRoot), vendors });
      const companion = readFileSync(
        join(distRoot, "claude/plugins/foo/skills/bar/procedure.md"),
        "utf8",
      );
      assert.match(companion, /see `superpowers:tdd` for tdd/);
      assert.ok(!companion.includes("{{skill:"), `raw token in companion:\n${companion}`);
    },
  );
});

test("compile warns when a companion references a skill resolved nowhere", async () => {
  const skillMd = `---
name: bar
description: x
companions:
  - file: procedure.md
    summary: Step procedure.
---

# Bar

{{companions}}
`;
  await withSkillFixture(
    {
      skillMd,
      companionFiles: { "procedure.md": "see {{skill:superpowers:ghost}}\n" },
    },
    async (repoRoot, distRoot) => {
      const warnings: string[] = [];
      await compilePlugins({
        layout: testLayout(repoRoot, distRoot),
        vendors,
        onWarnings: (_file, ws) => warnings.push(...ws),
      });
      const out = readFileSync(
        join(distRoot, "claude/plugins/foo/skills/bar/procedure.md"),
        "utf8",
      );
      assert.match(out, /see `superpowers:ghost`/);
      assert.ok(
        warnings.some((w) => w.includes("superpowers:ghost")),
        `expected an unresolved-ref warning, got:\n${warnings.join("\n")}`,
      );
    },
  );
});

test("compile resolves {{ref:...}} in companions relative to the skill directory", async () => {
  const skillMd = `---
name: bar
description: x
companions:
  - file: procedure.md
    summary: Step procedure.
---

# Bar

{{companions}}
`;
  await withPluginFixture(
    {
      extraFiles: {
        "shared/notes.md": "# Notes\n",
        "skills/bar/SKILL.md": skillMd,
        "skills/bar/procedure.md": "see {{ref:../../shared/notes.md}}\n",
      },
    },
    async (repoRoot, distRoot) => {
      await compilePlugins({ layout: testLayout(repoRoot, distRoot), vendors });
      const out = readFileSync(
        join(distRoot, "claude/plugins/foo/skills/bar/procedure.md"),
        "utf8",
      );
      assert.match(out, /see `\.\.\/\.\.\/shared\/notes\.md`/);
    },
  );
});

test("compile substitutes placeholders inside agent files", async () => {
  await withPluginFixture(
    {
      extraFiles: {
        "skills/bar/SKILL.md": `---\nname: bar\ndescription: x\n---\n\n# Bar\n`,
        "agents/reviewer.md": `---\nname: reviewer\ndescription: x\n---\n\nInvoke {{skill:foo:bar}} for help.\n`,
      },
    },
    async (repoRoot, distRoot) => {
      await compilePlugins({ layout: testLayout(repoRoot, distRoot), vendors });
      const out = readFileSync(join(distRoot, "claude/plugins/foo/agents/reviewer.md"), "utf8");
      assert.match(out, /Invoke `foo:bar` for help\./);
    },
  );
});

test("compile warns when an agent file references a skill resolved nowhere", async () => {
  await withPluginFixture(
    {
      extraFiles: {
        "agents/reviewer.md": `---\nname: reviewer\ndescription: x\n---\n\nSee {{skill:superpowers:ghost}}.\n`,
      },
    },
    async (repoRoot, distRoot) => {
      const warnings: string[] = [];
      await compilePlugins({
        layout: testLayout(repoRoot, distRoot),
        vendors,
        onWarnings: (_file, ws) => warnings.push(...ws),
      });
      const out = readFileSync(join(distRoot, "claude/plugins/foo/agents/reviewer.md"), "utf8");
      assert.match(out, /See `superpowers:ghost`\./);
      assert.ok(
        warnings.some((w) => w.includes("superpowers:ghost")),
        `expected an unresolved-ref warning, got:\n${warnings.join("\n")}`,
      );
    },
  );
});

test("compile substitutes placeholders inside command files", async () => {
  await withPluginFixture(
    {
      extraFiles: {
        "skills/bar/SKILL.md": `---\nname: bar\ndescription: x\n---\n\n# Bar\n`,
        "commands/ship.md": `---\nname: ship\ndescription: x\n---\n\nRun {{skill:foo:bar}} first.\n`,
      },
    },
    async (repoRoot, distRoot) => {
      await compilePlugins({ layout: testLayout(repoRoot, distRoot), vendors });
      const out = readFileSync(join(distRoot, "claude/plugins/foo/commands/ship.md"), "utf8");
      assert.match(out, /Run `foo:bar` first\./);
    },
  );
});

test("compile warns when a command file references a skill resolved nowhere", async () => {
  await withPluginFixture(
    {
      extraFiles: {
        "commands/ship.md": `---\nname: ship\ndescription: x\n---\n\nRun {{skill:superpowers:ghost}}.\n`,
      },
    },
    async (repoRoot, distRoot) => {
      const warnings: string[] = [];
      await compilePlugins({
        layout: testLayout(repoRoot, distRoot),
        vendors,
        onWarnings: (_file, ws) => warnings.push(...ws),
      });
      const out = readFileSync(join(distRoot, "claude/plugins/foo/commands/ship.md"), "utf8");
      assert.match(out, /Run `superpowers:ghost`\./);
      assert.ok(
        warnings.some((w) => w.includes("superpowers:ghost")),
        `expected an unresolved-ref warning, got:\n${warnings.join("\n")}`,
      );
    },
  );
});

test("compile resolves {{ref:...}} in agent files relative to the agent file", async () => {
  await withPluginFixture(
    {
      extraFiles: {
        "shared/notes.md": "# Notes\n",
        "agents/reviewer.md": `---\nname: reviewer\ndescription: x\n---\n\nsee {{ref:../shared/notes.md}}\n`,
      },
    },
    async (repoRoot, distRoot) => {
      await compilePlugins({ layout: testLayout(repoRoot, distRoot), vendors });
      const out = readFileSync(join(distRoot, "claude/plugins/foo/agents/reviewer.md"), "utf8");
      assert.match(out, /see `\.\.\/shared\/notes\.md`/);
    },
  );
});

test("compile builds the markdown-only fixture end-to-end", async () => {
  await withTempDist(async (dist) => {
    await compilePlugins({ layout: testLayout(mdSourceRoot, dist), vendors });

    const skillPath = join(dist, "claude/plugins/foo/skills/bar/SKILL.md");
    assert.ok(existsSync(skillPath), `expected ${skillPath} to exist`);

    const content = readFileSync(skillPath, "utf8");
    assert.match(content, /^---\nname: bar\ndescription: [^\n]+\n---\n/);
    assert.match(content, /Inlined verbatim from preamble\.md\./);
    assert.match(content, /`superpowers:test-driven-development`/);
    assert.doesNotMatch(content, /\{\{include:/);
    assert.doesNotMatch(content, /\{\{skill:/);

    const preambleCopy = join(dist, "claude/plugins/foo/skills/bar/preamble.md");
    assert.ok(!existsSync(preambleCopy), `did not expect ${preambleCopy} to exist`);
  });
});

test("compile substitutes {{command:plugin:name}} as `/plugin:name` for a discovered local command", async () => {
  await withSkillFixture(
    {
      skillMd: skillMarkdown("bar", "run {{command:dev-tools:open-pr}} to ship\n"),
    },
    async (repoRoot, distRoot) => {
      makeStubCommand(repoRoot, "dev-tools", "open-pr");
      await compilePlugins({ layout: testLayout(repoRoot, distRoot), vendors });
      const out = readFileSync(join(distRoot, "claude/plugins/foo/skills/bar/SKILL.md"), "utf8");
      assert.match(out, /run `\/dev-tools:open-pr` to ship/);
    },
  );
});

test("compile warns but still renders when {{command:...}} resolves to neither a local nor an installed command", async () => {
  await withSkillFixture(
    {
      skillMd: skillMarkdown("bar", "see {{command:dev-tools:ghost}}\n"),
    },
    async (repoRoot, distRoot) => {
      const warnings: string[] = [];
      await compilePlugins({
        layout: testLayout(repoRoot, distRoot),
        vendors,
        onWarnings: (_file, ws) => warnings.push(...ws),
      });
      const out = readFileSync(join(distRoot, "claude/plugins/foo/skills/bar/SKILL.md"), "utf8");
      assert.match(out, /see `\/dev-tools:ghost`/);
      assert.ok(
        warnings.some((w) => w.includes("dev-tools:ghost")),
        `expected an unresolved-ref warning, got:\n${warnings.join("\n")}`,
      );
    },
  );
});

test("compile fails when {{command:...}} value does not have <plugin>:<command> shape", async () => {
  await withSkillFixture(
    {
      skillMd: skillMarkdown("bar", "{{command:lonelyid}}\n"),
    },
    async (repoRoot, distRoot) => {
      await assert.rejects(
        compilePlugins({ layout: testLayout(repoRoot, distRoot), vendors }),
        /<plugin>:<command>/,
      );
    },
  );
});

test("compile substitutes {{agent:plugin:name}} as the scoped `plugin:name` handle for a discovered local agent", async () => {
  await withSkillFixture(
    {
      skillMd: skillMarkdown("bar", "dispatch {{agent:dev-tools:code-reviewer}} for review\n"),
    },
    async (repoRoot, distRoot) => {
      makeStubAgent(repoRoot, "dev-tools", "code-reviewer");
      await compilePlugins({ layout: testLayout(repoRoot, distRoot), vendors });
      const out = readFileSync(join(distRoot, "claude/plugins/foo/skills/bar/SKILL.md"), "utf8");
      assert.match(out, /dispatch `dev-tools:code-reviewer` for review/);
    },
  );
});

test("compile warns but still renders when {{agent:...}} resolves to neither a local nor an installed agent", async () => {
  await withSkillFixture(
    {
      skillMd: skillMarkdown("bar", "see {{agent:dev-tools:ghost}}\n"),
    },
    async (repoRoot, distRoot) => {
      const warnings: string[] = [];
      await compilePlugins({
        layout: testLayout(repoRoot, distRoot),
        vendors,
        onWarnings: (_file, ws) => warnings.push(...ws),
      });
      const out = readFileSync(join(distRoot, "claude/plugins/foo/skills/bar/SKILL.md"), "utf8");
      assert.match(out, /see `dev-tools:ghost`/);
      assert.ok(
        warnings.some((w) => w.includes("dev-tools:ghost")),
        `expected an unresolved-ref warning, got:\n${warnings.join("\n")}`,
      );
    },
  );
});

test("compile fails when {{agent:...}} value does not have <plugin>:<agent> shape", async () => {
  await withSkillFixture(
    {
      skillMd: skillMarkdown("bar", "{{agent:lonelyid}}\n"),
    },
    async (repoRoot, distRoot) => {
      await assert.rejects(
        compilePlugins({ layout: testLayout(repoRoot, distRoot), vendors }),
        /<plugin>:<agent>/,
      );
    },
  );
});

test("compile resolves {{agent:...}} against an installed plugin and renders the scoped handle", async () => {
  await withInstalledSources([{ plugin: "dev-tools", agent: "code-reviewer" }], async (sources) => {
    await withSkillFixture(
      {
        skillMd: skillMarkdown("bar", "dispatch {{agent:dev-tools:code-reviewer}} for review\n"),
      },
      async (repoRoot, distRoot) => {
        const warnings: string[] = [];
        await compilePlugins({
          layout: testLayout(repoRoot, distRoot),
          vendors,
          sources,
          onWarnings: (_file, ws) => warnings.push(...ws),
        });
        const out = readFileSync(join(distRoot, "claude/plugins/foo/skills/bar/SKILL.md"), "utf8");
        assert.match(out, /dispatch `dev-tools:code-reviewer` for review/);
        assert.deepEqual(warnings, [], "an installed agent ref should not warn");
      },
    );
  });
});

test("compile resolves {{command:...}} against an installed plugin and renders `/plugin:name`", async () => {
  await withInstalledSources([{ plugin: "dev-tools", command: "open-pr" }], async (sources) => {
    await withSkillFixture(
      {
        skillMd: skillMarkdown("bar", "run {{command:dev-tools:open-pr}} after merging\n"),
      },
      async (repoRoot, distRoot) => {
        await compilePlugins({ layout: testLayout(repoRoot, distRoot), vendors, sources });
        const out = readFileSync(join(distRoot, "claude/plugins/foo/skills/bar/SKILL.md"), "utf8");
        assert.match(out, /run `\/dev-tools:open-pr` after merging/);
      },
    );
  });
});

test("compile renders {{agent:code-simplifier:code-simplifier}} for a plugin whose name equals its agent", async () => {
  await withInstalledSources(
    [{ plugin: "code-simplifier", agent: "code-simplifier" }],
    async (sources) => {
      await withSkillFixture(
        {
          skillMd: skillMarkdown(
            "bar",
            "dispatch {{agent:code-simplifier:code-simplifier}} after coding\n",
          ),
        },
        async (repoRoot, distRoot) => {
          await compilePlugins({ layout: testLayout(repoRoot, distRoot), vendors, sources });
          const out = readFileSync(
            join(distRoot, "claude/plugins/foo/skills/bar/SKILL.md"),
            "utf8",
          );
          assert.match(out, /dispatch `code-simplifier:code-simplifier` after coding/);
        },
      );
    },
  );
});

test("compile substitutes placeholders in an undeclared .md file", async () => {
  await withPluginFixture(
    {
      extraFiles: {
        "notes/part.md": "shared body\n",
        "notes/scratch.md": "doc {{include:./part.md}} end\n",
      },
    },
    async (repoRoot, distRoot) => {
      await compilePlugins({ layout: testLayout(repoRoot, distRoot), vendors });
      const out = readFileSync(join(distRoot, "claude/plugins/foo/notes/scratch.md"), "utf8");
      assert.match(out, /shared body/);
      assert.doesNotMatch(out, /\{\{include/);
    },
  );
});

function hookRequiresManifest(
  hookRequires: ReadonlyArray<Record<string, string>>,
): Record<string, unknown> {
  return pluginManifest("foo", { extensions: { harness: { hookRequires } } });
}

test("compile accepts hookRequires that point to existing local artifacts", async () => {
  await withPluginFixture(
    {
      manifest: hookRequiresManifest([
        { event: "SessionStart", skill: "foo:bar" },
        { event: "UserPromptSubmit", command: "foo:open" },
        { event: "Stop", agent: "foo:rev" },
      ]),
    },
    async (repoRoot, distRoot) => {
      makeStubSkill(repoRoot, "foo", "bar");
      makeStubCommand(repoRoot, "foo", "open");
      makeStubAgent(repoRoot, "foo", "rev");
      await compilePlugins({ layout: testLayout(repoRoot, distRoot), vendors });
      assert.ok(existsSync(join(distRoot, "claude/plugins/foo/.claude-plugin/plugin.json")));
    },
  );
});

test("compile fails when a hookRequires skill slug is not a local skill", async () => {
  await withPluginFixture(
    { manifest: hookRequiresManifest([{ event: "SessionStart", skill: "foo:ghost" }]) },
    async (repoRoot, distRoot) => {
      await assert.rejects(
        compilePlugins({ layout: testLayout(repoRoot, distRoot), vendors }),
        /hookRequires.*foo:ghost.*not a local skill/i,
      );
    },
  );
});

test("compile fails when a hookRequires command slug is not a local command", async () => {
  await withPluginFixture(
    { manifest: hookRequiresManifest([{ event: "UserPromptSubmit", command: "foo:ghost" }]) },
    async (repoRoot, distRoot) => {
      await assert.rejects(
        compilePlugins({ layout: testLayout(repoRoot, distRoot), vendors }),
        /hookRequires.*foo:ghost.*not a local command/i,
      );
    },
  );
});

test("compile fails when a hookRequires agent slug is not a local agent", async () => {
  await withPluginFixture(
    { manifest: hookRequiresManifest([{ event: "Stop", agent: "foo:ghost" }]) },
    async (repoRoot, distRoot) => {
      await assert.rejects(
        compilePlugins({ layout: testLayout(repoRoot, distRoot), vendors }),
        /hookRequires.*foo:ghost.*not a local agent/i,
      );
    },
  );
});

test("compile cites the plugin.json path when a hookRequires slug is unresolved", async () => {
  await withPluginFixture(
    { manifest: hookRequiresManifest([{ event: "Stop", agent: "foo:ghost" }]) },
    async (repoRoot, distRoot) => {
      await assert.rejects(
        compilePlugins({ layout: testLayout(repoRoot, distRoot), vendors }),
        (error: unknown) =>
          error instanceof Error &&
          error.message.includes(join(repoRoot, "plugins/foo/plugin.json")),
      );
    },
  );
});

test("compile fails when extensions.harness.hookRequires sets more than one slug", async () => {
  await withPluginFixture(
    {
      manifest: hookRequiresManifest([{ event: "Stop", skill: "foo:bar", agent: "foo:rev" }]),
    },
    async (repoRoot, distRoot) => {
      await assert.rejects(
        compilePlugins({ layout: testLayout(repoRoot, distRoot), vendors }),
        /extensions\.harness: .*exactly one of skill \| command \| agent/,
      );
    },
  );
});

test("compile accepts a cross-plugin {{skill:other:tdd}} reference when `other` is declared as an extensions.claude dependency", async () => {
  await withPluginFixture(
    {
      manifest: pluginManifest("foo", { extensions: { claude: { dependencies: ["other"] } } }),
      extraFiles: {
        "skills/bar/SKILL.md": skillMarkdown("bar", "see {{skill:other:tdd}}\n"),
      },
    },
    async (repoRoot, distRoot) => {
      makeStubSkill(repoRoot, "other", "tdd");
      await compilePlugins({ layout: testLayout(repoRoot, distRoot), vendors });
      assert.ok(existsSync(join(distRoot, "claude/plugins/foo/skills/bar/SKILL.md")));
    },
  );
});

test("compile permits a cross-plugin {{skill:other:tdd}} reference between sibling local plugins without any dependencies declared", async () => {
  await withPluginFixture(
    {
      extraFiles: {
        "skills/bar/SKILL.md": skillMarkdown("bar", "see {{skill:other:tdd}}\n"),
      },
    },
    async (repoRoot, distRoot) => {
      makeStubSkill(repoRoot, "other", "tdd");
      const warnings: string[] = [];
      await compilePlugins({
        layout: testLayout(repoRoot, distRoot),
        vendors,
        onWarnings: (_file, ws) => warnings.push(...ws),
      });
      const out = readFileSync(join(distRoot, "claude/plugins/foo/skills/bar/SKILL.md"), "utf8");
      assert.match(out, /see `other:tdd`/);
      assert.deepEqual(warnings, [], "a sibling local skill ref should not warn");
    },
  );
});

test("compile permits a cross-plugin {{command:other:open}} reference between sibling local plugins without any dependencies declared", async () => {
  await withPluginFixture(
    {
      extraFiles: {
        "skills/bar/SKILL.md": skillMarkdown("bar", "run {{command:other:open}}\n"),
      },
    },
    async (repoRoot, distRoot) => {
      makeStubCommand(repoRoot, "other", "open");
      const warnings: string[] = [];
      await compilePlugins({
        layout: testLayout(repoRoot, distRoot),
        vendors,
        onWarnings: (_file, ws) => warnings.push(...ws),
      });
      const out = readFileSync(join(distRoot, "claude/plugins/foo/skills/bar/SKILL.md"), "utf8");
      assert.match(out, /run `\/other:open`/);
      assert.deepEqual(warnings, [], "a sibling local command ref should not warn");
    },
  );
});

test("compile permits a cross-plugin {{agent:other:reviewer}} reference between sibling local plugins without any dependencies declared", async () => {
  await withPluginFixture(
    {
      extraFiles: {
        "skills/bar/SKILL.md": skillMarkdown("bar", "dispatch {{agent:other:reviewer}}\n"),
      },
    },
    async (repoRoot, distRoot) => {
      makeStubAgent(repoRoot, "other", "reviewer");
      const warnings: string[] = [];
      await compilePlugins({
        layout: testLayout(repoRoot, distRoot),
        vendors,
        onWarnings: (_file, ws) => warnings.push(...ws),
      });
      const out = readFileSync(join(distRoot, "claude/plugins/foo/skills/bar/SKILL.md"), "utf8");
      assert.match(out, /dispatch `other:reviewer`/);
      assert.deepEqual(warnings, [], "a sibling local agent ref should not warn");
    },
  );
});

test("compile permits same-plugin {{skill:foo:bar}} reference without any dependencies declared", async () => {
  await withPluginFixture(
    {
      extraFiles: {
        "skills/bar/SKILL.md": skillMarkdown(
          "bar",
          "no self-loop, but: {{skill:foo:other-skill}}\n",
        ),
        "skills/other-skill/SKILL.md": skillMarkdown("other-skill", "# Other\n"),
      },
    },
    async (repoRoot, distRoot) => {
      await compilePlugins({ layout: testLayout(repoRoot, distRoot), vendors });
      assert.ok(existsSync(join(distRoot, "claude/plugins/foo/skills/bar/SKILL.md")));
    },
  );
});

test("compile does NOT enforce dependencies on a {{skill:...}} that resolves outside the marketplace", async () => {
  await withInstalledSources([{ plugin: "other", skill: "tdd" }], async (sources) => {
    await withPluginFixture(
      {
        extraFiles: {
          "skills/bar/SKILL.md": skillMarkdown("bar", "external ref: {{skill:other:tdd}}\n"),
        },
      },
      async (repoRoot, distRoot) => {
        await compilePlugins({ layout: testLayout(repoRoot, distRoot), vendors, sources });
        const out = readFileSync(join(distRoot, "claude/plugins/foo/skills/bar/SKILL.md"), "utf8");
        assert.match(out, /external ref: `other:tdd`/);
      },
    );
  });
});

test("compile emits object-form extensions.claude dependencies into the claude plugin manifest", async () => {
  const dependencies = [{ name: "other", marketplace: "claude-plugins-official" }];
  await withPluginFixture(
    {
      manifest: pluginManifest("foo", { extensions: { claude: { dependencies } } }),
      extraFiles: {
        "skills/bar/SKILL.md": skillMarkdown("bar", "see {{skill:other:tdd}}\n"),
      },
    },
    async (repoRoot, distRoot) => {
      makeStubSkill(repoRoot, "other", "tdd");
      await compilePlugins({ layout: testLayout(repoRoot, distRoot), vendors });
      const manifest = readJson(join(distRoot, "claude/plugins/foo/.claude-plugin/plugin.json"));
      assert.deepEqual(manifest["dependencies"], dependencies);
    },
  );
});
