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

import { compile } from "./index.js";
import { claudeVendor } from "../vendors/claude/index.js";
import type { PluginSource } from "../installed.js";

const vendors = [claudeVendor];

const fixturesRoot = fileURLToPath(new URL("./__fixtures__", import.meta.url));
const goodRoot = join(fixturesRoot, "good");
const companionRenderRoot = join(fixturesRoot, "companionRender");
const withPluginRoot = join(fixturesRoot, "withPlugin");
const mdSourceRoot = join(fixturesRoot, "mdSource");

async function withTempDist<T>(fn: (dist: string) => Promise<T>): Promise<T> {
  const dist = mkdtempSync(join(tmpdir(), "harness-kit-test-"));
  return fn(dist).finally(() => rmSync(dist, { recursive: true, force: true }));
}

function ensurePluginInMarketplace(srcRoot: string, pluginName: string): void {
  const pluginDir = join(srcRoot, "plugins", pluginName);
  mkdirSync(pluginDir, { recursive: true });
  const pluginTsPath = join(pluginDir, "PLUGIN.ts");
  const pluginJsonPath = join(pluginDir, ".claude-plugin/plugin.json");
  if (!existsSync(pluginTsPath) && !existsSync(pluginJsonPath)) {
    mkdirSync(join(pluginDir, ".claude-plugin"), { recursive: true });
    writeFileSync(
      pluginJsonPath,
      JSON.stringify(
        { name: pluginName, version: "0.0.1", description: "test fixture plugin" },
        null,
        2,
      ) + "\n",
    );
  }

  const marketplacePath = join(srcRoot, ".claude-plugin/marketplace.json");
  mkdirSync(join(srcRoot, ".claude-plugin"), { recursive: true });
  const existing = existsSync(marketplacePath)
    ? (JSON.parse(readFileSync(marketplacePath, "utf8")) as {
        plugins: Array<{ name: string; source: string }>;
      })
    : null;
  if (existing) {
    if (existing.plugins.some((p) => p.name === pluginName)) return;
    existing.plugins.push({ name: pluginName, source: `./plugins/${pluginName}` });
    writeFileSync(marketplacePath, JSON.stringify(existing, null, 2) + "\n");
    for (const peer of existing.plugins) {
      if (peer.name === pluginName) continue;
      addDependency(srcRoot, peer.name, pluginName);
    }
    return;
  }
  writeFileSync(
    marketplacePath,
    JSON.stringify(
      {
        name: "test-marketplace",
        owner: { name: "harness-kit-tests" },
        plugins: [{ name: pluginName, source: `./plugins/${pluginName}` }],
      },
      null,
      2,
    ) + "\n",
  );
}

function addDependency(srcRoot: string, plugin: string, dependency: string): void {
  const pluginJsonPath = join(srcRoot, "plugins", plugin, ".claude-plugin/plugin.json");
  if (!existsSync(pluginJsonPath)) return;
  const manifest = JSON.parse(readFileSync(pluginJsonPath, "utf8")) as {
    dependencies?: string[];
  };
  const deps = new Set(manifest.dependencies ?? []);
  if (deps.has(dependency)) return;
  deps.add(dependency);
  writeFileSync(
    pluginJsonPath,
    JSON.stringify({ ...manifest, dependencies: [...deps] }, null, 2) + "\n",
  );
}

interface SkillFixtureOptions {
  readonly skillSource?: string;
  readonly skillMd?: string;
  readonly bodyMd?: string;
  readonly companionFiles?: Readonly<Record<string, string>>;
}

async function withSkillFixture<T>(
  options: SkillFixtureOptions,
  fn: (srcRoot: string, distRoot: string) => Promise<T>,
): Promise<T> {
  const sandbox = mkdtempSync(join(fixturesRoot, "_tmp_"));
  const srcRoot = join(sandbox, "src");
  const distRoot = mkdtempSync(join(tmpdir(), "harness-kit-dist-"));
  const skillDir = join(srcRoot, "plugins/foo/skills/bar");
  mkdirSync(skillDir, { recursive: true });
  if (options.skillSource !== undefined) {
    writeFileSync(join(skillDir, "SKILL.ts"), options.skillSource);
  }
  if (options.skillMd !== undefined) {
    writeFileSync(join(skillDir, "SKILL.md"), options.skillMd);
  }
  if (options.bodyMd !== undefined) {
    writeFileSync(join(skillDir, "body.md"), options.bodyMd);
  }
  for (const [name, content] of Object.entries(options.companionFiles ?? {})) {
    writeFileSync(join(skillDir, name), content);
  }
  ensurePluginInMarketplace(srcRoot, "foo");
  return fn(srcRoot, distRoot).finally(() => {
    rmSync(sandbox, { recursive: true, force: true });
    rmSync(distRoot, { recursive: true, force: true });
  });
}

interface PluginFixtureOptions {
  readonly pluginName?: string;
  readonly pluginSource: string;
  readonly extraFiles?: Readonly<Record<string, string>>;
}

async function withPluginFixture<T>(
  options: PluginFixtureOptions,
  fn: (srcRoot: string, distRoot: string) => Promise<T>,
): Promise<T> {
  const sandbox = mkdtempSync(join(fixturesRoot, "_tmp_"));
  const srcRoot = join(sandbox, "src");
  const distRoot = mkdtempSync(join(tmpdir(), "harness-kit-dist-"));
  const pluginDir = join(srcRoot, "plugins", options.pluginName ?? "foo");
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(join(pluginDir, "PLUGIN.ts"), options.pluginSource);
  for (const [relPath, content] of Object.entries(options.extraFiles ?? {})) {
    const target = join(pluginDir, relPath);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, content);
  }
  ensurePluginInMarketplace(srcRoot, options.pluginName ?? "foo");
  return fn(srcRoot, distRoot).finally(() => {
    rmSync(sandbox, { recursive: true, force: true });
    rmSync(distRoot, { recursive: true, force: true });
  });
}

function makeStubSkill(srcRoot: string, plugin: string, name: string): void {
  const dir = join(srcRoot, "plugins", plugin, "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.ts"),
    `import { defineSkill } from "#harness-kit";\nexport default defineSkill({ name: "${name}", description: "stub" });\n`,
  );
  writeFileSync(join(dir, "body.md"), `# ${name}\n`);
  ensurePluginInMarketplace(srcRoot, plugin);
}

function makeStubCommand(srcRoot: string, plugin: string, name: string): void {
  const dir = join(srcRoot, "plugins", plugin, "commands");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${name}.md`),
    `---\nname: ${name}\ndescription: stub command\n---\n\n# ${name}\n`,
  );
  ensurePluginInMarketplace(srcRoot, plugin);
}

function makeStubAgent(srcRoot: string, plugin: string, name: string): void {
  const dir = join(srcRoot, "plugins", plugin, "agents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${name}.md`),
    `---\nname: ${name}\ndescription: stub agent\n---\n\n# ${name}\n`,
  );
  ensurePluginInMarketplace(srcRoot, plugin);
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

const SKILL_TS_BARE = `import { defineSkill } from "#harness-kit";
export default defineSkill({ name: "bar", description: "fixture skill" });
`;

const SKILL_TS_WITH_COMPANION = `import { defineSkill } from "#harness-kit";
export default defineSkill({
  name: "bar",
  description: "fixture skill with companions",
  companions: [{ file: "a.md", summary: "First." }],
});
`;

test("compile emits SKILL.md with frontmatter and body for a typed skill source", async () => {
  await withTempDist(async (dist) => {
    await compile({ srcRoot: goodRoot, outRoot: dist, vendors });

    const skillPath = join(dist, "claude/foo/skills/bar/SKILL.md");
    assert.ok(existsSync(skillPath), `expected ${skillPath} to exist`);

    const content = readFileSync(skillPath, "utf8");
    assert.match(
      content,
      /^---\nname: bar\ndescription: A tiny test skill that asserts the compile pipeline works\.\n---\n\n# Bar\n\nThis is the body\.\n$/,
    );
  });
});

test("compile copies non-skill plugin files verbatim", async () => {
  await withTempDist(async (dist) => {
    await compile({ srcRoot: goodRoot, outRoot: dist, vendors });

    const manifestPath = join(dist, "claude/foo/.claude-plugin/plugin.json");
    assert.ok(existsSync(manifestPath), `expected ${manifestPath} to exist`);

    const original = readFileSync(join(goodRoot, "plugins/foo/.claude-plugin/plugin.json"), "utf8");
    const copied = readFileSync(manifestPath, "utf8");
    assert.equal(copied, original);
  });
});

test("compile does not write SKILL.ts source files into dist", async () => {
  await withTempDist(async (dist) => {
    await compile({ srcRoot: goodRoot, outRoot: dist, vendors });

    const tsPath = join(dist, "claude/foo/skills/bar/SKILL.ts");
    assert.ok(!existsSync(tsPath), `did not expect ${tsPath} to exist`);
  });
});

test("compile emits a per-vendor marketplace.json under dist/<vendor>/.<vendor>-plugin/", async () => {
  await withTempDist(async (dist) => {
    await compile({ srcRoot: goodRoot, outRoot: dist, vendors });

    const distManifest = join(dist, "claude/.claude-plugin/marketplace.json");
    assert.ok(existsSync(distManifest), `expected ${distManifest} to exist`);
    const emitted = JSON.parse(readFileSync(distManifest, "utf8")) as {
      name: string;
      plugins: ReadonlyArray<{ name: string; source: unknown }>;
    };
    const original = JSON.parse(
      readFileSync(join(goodRoot, ".claude-plugin/marketplace.json"), "utf8"),
    ) as { name: string };
    assert.equal(emitted.name, original.name);
    assert.ok(emitted.plugins.length > 0);
  });
});

test("compile ignores top-level files outside plugins/ and .claude-plugin/", async () => {
  await withTempDist(async (dist) => {
    await compile({ srcRoot: goodRoot, outRoot: dist, vendors });

    const stray = join(dist, "README.md");
    assert.ok(!existsSync(stray), `did not expect ${stray} to exist`);
  });
});

test("compile renders typed companions into the {{companions}} placeholder", async () => {
  await withTempDist(async (dist) => {
    await compile({ srcRoot: companionRenderRoot, outRoot: dist, vendors });

    const skillPath = join(dist, "claude/foo/skills/bar/SKILL.md");
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

test("compile reads body from sibling body.md", async () => {
  await withSkillFixture(
    {
      skillSource: SKILL_TS_BARE,
      bodyMd: "# Bar from body.md\n\nReal body content.\n",
    },
    async (srcRoot, distRoot) => {
      await compile({ srcRoot, outRoot: distRoot, vendors });
      const out = readFileSync(join(distRoot, "claude/foo/skills/bar/SKILL.md"), "utf8");
      assert.match(out, /# Bar from body\.md\n\nReal body content\./);
    },
  );
});

test("compile fails when body.md is missing", async () => {
  await withSkillFixture({ skillSource: SKILL_TS_BARE }, async (srcRoot, distRoot) => {
    await assert.rejects(compile({ srcRoot, outRoot: distRoot, vendors }), /body\.md/);
  });
});

test("compile does not copy body.md into dist", async () => {
  await withSkillFixture(
    { skillSource: SKILL_TS_BARE, bodyMd: "# Bar\n" },
    async (srcRoot, distRoot) => {
      await compile({ srcRoot, outRoot: distRoot, vendors });
      const stray = join(distRoot, "claude/foo/skills/bar/body.md");
      assert.ok(!existsSync(stray), `did not expect ${stray} to exist`);
    },
  );
});

test("compile substitutes {{skill:...}} for a discovered local skill", async () => {
  await withSkillFixture(
    {
      skillSource: SKILL_TS_BARE,
      bodyMd: "see {{skill:dev-tools:ruby}} for ruby idioms",
    },
    async (srcRoot, distRoot) => {
      makeStubSkill(srcRoot, "dev-tools", "ruby");
      await compile({ srcRoot, outRoot: distRoot, vendors });
      const out = readFileSync(join(distRoot, "claude/foo/skills/bar/SKILL.md"), "utf8");
      assert.match(out, /see `dev-tools:ruby` for ruby idioms/);
    },
  );
});

test("compile warns but still renders when {{skill:...}} resolves to neither a local nor an installed skill", async () => {
  await withSkillFixture(
    {
      skillSource: SKILL_TS_BARE,
      bodyMd: "see {{skill:superpowers:nonexistent}}",
    },
    async (srcRoot, distRoot) => {
      const warnings: string[] = [];
      await compile({
        srcRoot,
        outRoot: distRoot,
        vendors,
        onWarnings: (_file, ws) => warnings.push(...ws),
      });
      const out = readFileSync(join(distRoot, "claude/foo/skills/bar/SKILL.md"), "utf8");
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
      skillSource: SKILL_TS_BARE,
      bodyMd: "see {{skill:lonelyid}} for nothing",
    },
    async (srcRoot, distRoot) => {
      await assert.rejects(compile({ srcRoot, outRoot: distRoot, vendors }), /<plugin>:<skill>/);
    },
  );
});

test("compile fails when companions are declared but {{companions}} token is absent", async () => {
  await withSkillFixture(
    {
      skillSource: SKILL_TS_WITH_COMPANION,
      bodyMd: "# Bar\n\nNo token here.\n",
      companionFiles: { "a.md": "# A\n" },
    },
    async (srcRoot, distRoot) => {
      await assert.rejects(compile({ srcRoot, outRoot: distRoot, vendors }), /\{\{companions\}\}/);
    },
  );
});

test("compile fails when {{companions}} is present but no companions are declared", async () => {
  await withSkillFixture(
    {
      skillSource: SKILL_TS_BARE,
      bodyMd: "# Bar\n\n{{companions}}\n",
    },
    async (srcRoot, distRoot) => {
      await assert.rejects(
        compile({ srcRoot, outRoot: distRoot, vendors }),
        /no companions are declared/,
      );
    },
  );
});

test("compile fails on unknown placeholder prefix", async () => {
  await withSkillFixture(
    {
      skillSource: SKILL_TS_BARE,
      bodyMd: "# Bar\n\n{{nope:foo}}\n",
    },
    async (srcRoot, distRoot) => {
      await assert.rejects(
        compile({ srcRoot, outRoot: distRoot, vendors }),
        /unknown placeholder prefix "nope"/,
      );
    },
  );
});

test("compile rejects a default export that violates SkillSchema (e.g. defineSkill is bypassed)", async () => {
  const SKILL_TS_BYPASSES_DEFINE_SKILL = `import type { Skill } from "#harness-kit";
export default { name: "bar", description: "line one\\nline two" } as Skill;
`;
  await withSkillFixture(
    {
      skillSource: SKILL_TS_BYPASSES_DEFINE_SKILL,
      bodyMd: "# Bar\n",
    },
    async (srcRoot, distRoot) => {
      await assert.rejects(compile({ srcRoot, outRoot: distRoot, vendors }), /description/i);
    },
  );
});

test("compile emits plugin.json from PLUGIN.ts with legacy keys preserved", async () => {
  await withTempDist(async (dist) => {
    await compile({ srcRoot: withPluginRoot, outRoot: dist, vendors });

    const manifestPath = join(dist, "claude/foo/.claude-plugin/plugin.json");
    assert.ok(existsSync(manifestPath), `expected ${manifestPath} to exist`);

    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    assert.equal(manifest["name"], "foo");
    assert.equal(manifest["version"], "1.2.3");
    assert.equal(manifest["description"], "demo plugin used by withPlugin fixture");
    assert.equal(manifest["license"], "MIT");
    assert.deepEqual(manifest["keywords"], ["fixture", "demo"]);
    assert.deepEqual(manifest["dependencies"], ["bar-core"]);
  });
});

test("compile does not write PLUGIN.ts source files into dist", async () => {
  await withTempDist(async (dist) => {
    await compile({ srcRoot: withPluginRoot, outRoot: dist, vendors });

    const tsPath = join(dist, "claude/foo/PLUGIN.ts");
    assert.ok(!existsSync(tsPath), `did not expect ${tsPath} to exist`);
  });
});

test("compile does not emit context into the legacy plugin.json", async () => {
  await withTempDist(async (dist) => {
    await compile({ srcRoot: withPluginRoot, outRoot: dist, vendors });

    const manifest = JSON.parse(
      readFileSync(join(dist, "claude/foo/.claude-plugin/plugin.json"), "utf8"),
    ) as Record<string, unknown>;
    assert.equal("context" in manifest, false);
  });
});

test("compile rejects collision when both PLUGIN.ts and .claude-plugin/plugin.json exist", async () => {
  await withPluginFixture(
    {
      pluginSource: `import { definePlugin } from "#harness-kit";
export default definePlugin({ name: "foo", version: "1.0.0", description: "demo" });
`,
      extraFiles: {
        ".claude-plugin/plugin.json": JSON.stringify({ name: "foo", version: "1.0.0" }),
      },
    },
    async (srcRoot, distRoot) => {
      await assert.rejects(
        compile({ srcRoot, outRoot: distRoot, vendors }),
        /both PLUGIN\.ts and \.claude-plugin\/plugin\.json/,
      );
    },
  );
});

test("compile fails when PLUGIN.ts name does not match the plugin folder", async () => {
  await withPluginFixture(
    {
      pluginName: "foo",
      pluginSource: `import { definePlugin } from "#harness-kit";
export default definePlugin({ name: "wrong", version: "1.0.0", description: "demo" });
`,
    },
    async (srcRoot, distRoot) => {
      await assert.rejects(
        compile({ srcRoot, outRoot: distRoot, vendors }),
        /name "wrong" does not match folder "foo"/,
      );
    },
  );
});

test("compile fails when a context entry references a missing file", async () => {
  await withPluginFixture(
    {
      pluginSource: `import { definePlugin } from "#harness-kit";
export default definePlugin({
  name: "foo",
  version: "1.0.0",
  description: "demo",
  context: [{ file: "context/ghost.md", summary: "missing" }],
});
`,
    },
    async (srcRoot, distRoot) => {
      await assert.rejects(
        compile({ srcRoot, outRoot: distRoot, vendors }),
        /context entry.*context\/ghost\.md/,
      );
    },
  );
});

test("compile accepts a plugin with context whose files exist", async () => {
  await withPluginFixture(
    {
      pluginSource: `import { definePlugin } from "#harness-kit";
export default definePlugin({
  name: "foo",
  version: "1.0.0",
  description: "demo",
  context: [{ file: "context/instructions.md", summary: "ok" }],
});
`,
      extraFiles: {
        "context/instructions.md": "# Instructions\n",
      },
    },
    async (srcRoot, distRoot) => {
      await compile({ srcRoot, outRoot: distRoot, vendors });
      assert.ok(existsSync(join(distRoot, "claude/foo/.claude-plugin/plugin.json")));
      assert.ok(existsSync(join(distRoot, "claude/foo/context/instructions.md")));
    },
  );
});

test("compile substitutes {{ref:path}} for a file that exists relative to the skill", async () => {
  await withPluginFixture(
    {
      pluginSource: `import { definePlugin } from "#harness-kit";
export default definePlugin({ name: "foo", version: "1.0.0", description: "demo" });
`,
      extraFiles: {
        "shared/linear-ids.md": "# Linear IDs\n",
        "skills/bar/SKILL.ts": `import { defineSkill } from "#harness-kit";
export default defineSkill({ name: "bar", description: "fixture" });
`,
        "skills/bar/body.md": "see {{ref:../../shared/linear-ids.md}} for the map\n",
      },
    },
    async (srcRoot, distRoot) => {
      await compile({ srcRoot, outRoot: distRoot, vendors });
      const out = readFileSync(join(distRoot, "claude/foo/skills/bar/SKILL.md"), "utf8");
      assert.match(out, /see `\.\.\/\.\.\/shared\/linear-ids\.md` for the map/);
    },
  );
});

test("compile fails when {{ref:path}} resolves to a missing file", async () => {
  await withPluginFixture(
    {
      pluginSource: `import { definePlugin } from "#harness-kit";
export default definePlugin({ name: "foo", version: "1.0.0", description: "demo" });
`,
      extraFiles: {
        "skills/bar/SKILL.ts": `import { defineSkill } from "#harness-kit";
export default defineSkill({ name: "bar", description: "fixture" });
`,
        "skills/bar/body.md": "see {{ref:../../shared/missing.md}}\n",
      },
    },
    async (srcRoot, distRoot) => {
      await assert.rejects(
        compile({ srcRoot, outRoot: distRoot, vendors }),
        /ref.*missing\.md.*not found/,
      );
    },
  );
});

test("compile preserves the executable bit on hook scripts copied through dist", async () => {
  await withPluginFixture(
    {
      pluginSource: `import { definePlugin } from "#harness-kit";
export default definePlugin({ name: "foo", version: "1.0.0", description: "demo" });
`,
      extraFiles: { "hooks/example.sh": "#!/usr/bin/env bash\necho hi\n" },
    },
    async (srcRoot, distRoot) => {
      chmodSync(join(srcRoot, "plugins/foo/hooks/example.sh"), 0o755);
      await compile({ srcRoot, outRoot: distRoot, vendors });

      const distScript = join(distRoot, "claude/foo/hooks/example.sh");
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

test("compile emits dist SKILL.md from a plain SKILL.md source", async () => {
  const skillMd = `---
name: bar
description: plain markdown skill
---

# Bar
inline body
`;
  await withSkillFixture({ skillMd }, async (srcRoot, distRoot) => {
    await compile({ srcRoot, outRoot: distRoot, vendors });
    const out = readFileSync(join(distRoot, "claude/foo/skills/bar/SKILL.md"), "utf8");
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
  await withSkillFixture({ skillMd }, async (srcRoot, distRoot) => {
    await compile({ srcRoot, outRoot: distRoot, vendors });
    const out = readFileSync(join(distRoot, "claude/foo/skills/bar/SKILL.md"), "utf8");
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
    async (srcRoot, distRoot) => {
      await compile({ srcRoot, outRoot: distRoot, vendors });
      const out = readFileSync(join(distRoot, "claude/foo/skills/bar/SKILL.md"), "utf8");
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
    async (srcRoot, distRoot) => {
      await compile({ srcRoot, outRoot: distRoot, vendors });
      const out = readFileSync(join(distRoot, "claude/foo/skills/bar/SKILL.md"), "utf8");
      const frontmatterMatch = /^---\n([\s\S]*?)\n---/.exec(out);
      assert.ok(frontmatterMatch, "dist file should have frontmatter");
      const fm = frontmatterMatch[1] ?? "";
      assert.match(fm, /companions:/);
      assert.match(fm, /file: a\.md/);
      assert.match(fm, /summary: First\./);
    },
  );
});

test("compile fails when both SKILL.ts and SKILL.md exist in the same skill folder", async () => {
  await withSkillFixture(
    {
      skillSource: SKILL_TS_BARE,
      skillMd: `---\nname: bar\ndescription: x\n---\n\n# Bar\n`,
      bodyMd: "# Bar\n",
    },
    async (srcRoot, distRoot) => {
      await assert.rejects(
        compile({ srcRoot, outRoot: distRoot, vendors }),
        /both SKILL\.ts and SKILL\.md/,
      );
    },
  );
});

test("compile fails when SKILL.md and body.md coexist in the same skill folder", async () => {
  const skillMd = `---\nname: bar\ndescription: x\n---\n\n# Bar\n`;
  await withSkillFixture({ skillMd, bodyMd: "# rogue body\n" }, async (srcRoot, distRoot) => {
    await assert.rejects(compile({ srcRoot, outRoot: distRoot, vendors }), /body\.md.*forbidden/i);
  });
});

test("compile does not write the source SKILL.md as both rewritten skill and verbatim copy", async () => {
  const skillMd = `---\nname: bar\ndescription: x\n---\n\nsee {{skill:foo:bar}}\n`;
  await withSkillFixture({ skillMd }, async (srcRoot, distRoot) => {
    await compile({ srcRoot, outRoot: distRoot, vendors });
    const out = readFileSync(join(distRoot, "claude/foo/skills/bar/SKILL.md"), "utf8");
    assert.ok(
      !out.includes("{{skill:"),
      `dist SKILL.md should be the rewritten version, got:\n${out}`,
    );
  });
});

test("compile renders {{skill:...}} from a plain SKILL.md to a TS-authored sibling", async () => {
  const skillMd = `---\nname: bar\ndescription: x\n---\n\nsee {{skill:dev-tools:ruby}}\n`;
  await withSkillFixture({ skillMd }, async (srcRoot, distRoot) => {
    makeStubSkill(srcRoot, "dev-tools", "ruby");
    await compile({ srcRoot, outRoot: distRoot, vendors });
    const out = readFileSync(join(distRoot, "claude/foo/skills/bar/SKILL.md"), "utf8");
    assert.match(out, /see `dev-tools:ruby`/);
  });
});

test("compile discovers a SKILL.md skill as a local skill (visible to {{skill:...}} from elsewhere)", async () => {
  const skillMd = `---\nname: bar\ndescription: x\n---\n\nsee {{skill:other:peer}}\n`;
  await withSkillFixture({ skillMd }, async (srcRoot, distRoot) => {
    const peerDir = join(srcRoot, "plugins/other/skills/peer");
    mkdirSync(peerDir, { recursive: true });
    writeFileSync(join(peerDir, "SKILL.md"), `---\nname: peer\ndescription: peer\n---\n\n# Peer\n`);
    ensurePluginInMarketplace(srcRoot, "other");
    await compile({ srcRoot, outRoot: distRoot, vendors });
    const out = readFileSync(join(distRoot, "claude/foo/skills/bar/SKILL.md"), "utf8");
    assert.match(out, /see `other:peer`/);
  });
});

test("compile runs consumer-supplied bodyInvariants", async () => {
  const callsForbidden = (body: string): string[] =>
    body.includes("FORBIDDEN") ? [`body contains forbidden token`] : [];
  await withSkillFixture(
    {
      skillSource: SKILL_TS_BARE,
      bodyMd: "# Bar\n\nFORBIDDEN should fail.\n",
    },
    async (srcRoot, distRoot) => {
      await assert.rejects(
        compile({
          srcRoot,
          outRoot: distRoot,
          vendors,
          bodyInvariants: [callsForbidden],
        }),
        /forbidden token/,
      );
    },
  );
});

test("compile expands {{include:./path.md}} in a SKILL.md body", async () => {
  const skillMd = `---\nname: bar\ndescription: x\n---\n\nbefore\n{{include:./fragment.md}}\nafter\n`;
  await withSkillFixture(
    { skillMd, companionFiles: { "fragment.md": "INLINED-CONTENT\n" } },
    async (srcRoot, distRoot) => {
      await compile({ srcRoot, outRoot: distRoot, vendors });
      const out = readFileSync(join(distRoot, "claude/foo/skills/bar/SKILL.md"), "utf8");
      assert.match(out, /before\nINLINED-CONTENT\nafter/);
      assert.ok(!out.includes("{{include:"), `raw include token survived in:\n${out}`);
    },
  );
});

test("compile resolves placeholders inside an included file against the host skill", async () => {
  const skillMd = `---\nname: bar\ndescription: x\n---\n\n{{include:./shared.md}}\n`;
  await withSkillFixture(
    { skillMd, companionFiles: { "shared.md": "see {{skill:foo:bar}} please\n" } },
    async (srcRoot, distRoot) => {
      await compile({ srcRoot, outRoot: distRoot, vendors });
      const out = readFileSync(join(distRoot, "claude/foo/skills/bar/SKILL.md"), "utf8");
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
    async (srcRoot, distRoot) => {
      await assert.rejects(compile({ srcRoot, outRoot: distRoot, vendors }), /cycle/);
    },
  );
});

test("compile fails when an include path escapes the skill directory", async () => {
  const skillMd = `---\nname: bar\ndescription: x\n---\n\n{{include:../../leak.md}}\n`;
  await withSkillFixture({ skillMd }, async (srcRoot, distRoot) => {
    await assert.rejects(compile({ srcRoot, outRoot: distRoot, vendors }), /escapes/);
  });
});

test("compile fails when an include target is missing", async () => {
  const skillMd = `---\nname: bar\ndescription: x\n---\n\n{{include:./ghost.md}}\n`;
  await withSkillFixture({ skillMd }, async (srcRoot, distRoot) => {
    await assert.rejects(compile({ srcRoot, outRoot: distRoot, vendors }), /not found/);
  });
});

test("compile does not copy included .md files into dist", async () => {
  const skillMd = `---\nname: bar\ndescription: x\n---\n\n{{include:./fragment.md}}\n`;
  await withSkillFixture(
    { skillMd, companionFiles: { "fragment.md": "inlined\n" } },
    async (srcRoot, distRoot) => {
      await compile({ srcRoot, outRoot: distRoot, vendors });
      const stray = join(distRoot, "claude/foo/skills/bar/fragment.md");
      assert.ok(!existsSync(stray), `included file should not land in dist at ${stray}`);
    },
  );
});

test("compile leaves frontmatter untouched when {{include:...}} appears in body", async () => {
  const skillMd = `---\nname: bar\ndescription: untouched description\n---\n\n{{include:./fragment.md}}\n`;
  await withSkillFixture(
    { skillMd, companionFiles: { "fragment.md": "body content\n" } },
    async (srcRoot, distRoot) => {
      await compile({ srcRoot, outRoot: distRoot, vendors });
      const out = readFileSync(join(distRoot, "claude/foo/skills/bar/SKILL.md"), "utf8");
      assert.match(out, /^---\nname: bar\ndescription: untouched description\n---\n\n/);
    },
  );
});

test("compile does not flag an included sibling as an undeclared companion", async () => {
  const skillMd = `---\nname: bar\ndescription: x\n---\n\n{{include:./fragment.md}}\n`;
  await withSkillFixture(
    { skillMd, companionFiles: { "fragment.md": "inlined\n" } },
    async (srcRoot, distRoot) => {
      await compile({ srcRoot, outRoot: distRoot, vendors });
    },
  );
});

test("compile substitutes {{skill:...}} inside the frontmatter description", async () => {
  const skillMd = `---\nname: bar\ndescription: use {{skill:dev-tools:ruby}} instead\n---\n\n# Bar\n`;
  await withSkillFixture({ skillMd }, async (srcRoot, distRoot) => {
    makeStubSkill(srcRoot, "dev-tools", "ruby");
    await compile({ srcRoot, outRoot: distRoot, vendors });
    const out = readFileSync(join(distRoot, "claude/foo/skills/bar/SKILL.md"), "utf8");
    assert.match(out, /description: use `dev-tools:ruby` instead/);
    assert.ok(!out.includes("{{skill:"), `raw token survived in frontmatter:\n${out}`);
  });
});

test("compile substitutes a cross-marketplace {{skill:...}} inside the frontmatter description", async () => {
  const skillMd = `---\nname: bar\ndescription: see {{skill:superpowers:tdd}} for details\n---\n\n# Bar\n`;
  await withSkillFixture({ skillMd }, async (srcRoot, distRoot) => {
    await compile({ srcRoot, outRoot: distRoot, vendors });
    const out = readFileSync(join(distRoot, "claude/foo/skills/bar/SKILL.md"), "utf8");
    assert.match(out, /description: see `superpowers:tdd` for details/);
    assert.ok(!out.includes("{{skill:"), `raw token survived in frontmatter:\n${out}`);
  });
});

test("compile warns when a frontmatter description references a skill resolved nowhere", async () => {
  const skillMd = `---\nname: bar\ndescription: see {{skill:superpowers:ghost}}\n---\n\n# Bar\n`;
  await withSkillFixture({ skillMd }, async (srcRoot, distRoot) => {
    const warnings: string[] = [];
    await compile({
      srcRoot,
      outRoot: distRoot,
      vendors,
      onWarnings: (_file, ws) => warnings.push(...ws),
    });
    const out = readFileSync(join(distRoot, "claude/foo/skills/bar/SKILL.md"), "utf8");
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
    async (srcRoot, distRoot) => {
      await compile({ srcRoot, outRoot: distRoot, vendors });
      const companion = readFileSync(join(distRoot, "claude/foo/skills/bar/procedure.md"), "utf8");
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
    async (srcRoot, distRoot) => {
      const warnings: string[] = [];
      await compile({
        srcRoot,
        outRoot: distRoot,
        vendors,
        onWarnings: (_file, ws) => warnings.push(...ws),
      });
      const out = readFileSync(join(distRoot, "claude/foo/skills/bar/procedure.md"), "utf8");
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
      pluginSource: `import { definePlugin } from "#harness-kit";
export default definePlugin({ name: "foo", version: "1.0.0", description: "demo" });
`,
      extraFiles: {
        "shared/notes.md": "# Notes\n",
        "skills/bar/SKILL.md": skillMd,
        "skills/bar/procedure.md": "see {{ref:../../shared/notes.md}}\n",
      },
    },
    async (srcRoot, distRoot) => {
      await compile({ srcRoot, outRoot: distRoot, vendors });
      const out = readFileSync(join(distRoot, "claude/foo/skills/bar/procedure.md"), "utf8");
      assert.match(out, /see `\.\.\/\.\.\/shared\/notes\.md`/);
    },
  );
});

test("compile substitutes placeholders inside agent files", async () => {
  await withPluginFixture(
    {
      pluginSource: `import { definePlugin } from "#harness-kit";
export default definePlugin({ name: "foo", version: "1.0.0", description: "demo" });
`,
      extraFiles: {
        "skills/bar/SKILL.md": `---\nname: bar\ndescription: x\n---\n\n# Bar\n`,
        "agents/reviewer.md": `---\nname: reviewer\ndescription: x\n---\n\nInvoke {{skill:foo:bar}} for help.\n`,
      },
    },
    async (srcRoot, distRoot) => {
      await compile({ srcRoot, outRoot: distRoot, vendors });
      const out = readFileSync(join(distRoot, "claude/foo/agents/reviewer.md"), "utf8");
      assert.match(out, /Invoke `foo:bar` for help\./);
    },
  );
});

test("compile warns when an agent file references a skill resolved nowhere", async () => {
  await withPluginFixture(
    {
      pluginSource: `import { definePlugin } from "#harness-kit";
export default definePlugin({ name: "foo", version: "1.0.0", description: "demo" });
`,
      extraFiles: {
        "agents/reviewer.md": `---\nname: reviewer\ndescription: x\n---\n\nSee {{skill:superpowers:ghost}}.\n`,
      },
    },
    async (srcRoot, distRoot) => {
      const warnings: string[] = [];
      await compile({
        srcRoot,
        outRoot: distRoot,
        vendors,
        onWarnings: (_file, ws) => warnings.push(...ws),
      });
      const out = readFileSync(join(distRoot, "claude/foo/agents/reviewer.md"), "utf8");
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
      pluginSource: `import { definePlugin } from "#harness-kit";
export default definePlugin({ name: "foo", version: "1.0.0", description: "demo" });
`,
      extraFiles: {
        "skills/bar/SKILL.md": `---\nname: bar\ndescription: x\n---\n\n# Bar\n`,
        "commands/ship.md": `---\nname: ship\ndescription: x\n---\n\nRun {{skill:foo:bar}} first.\n`,
      },
    },
    async (srcRoot, distRoot) => {
      await compile({ srcRoot, outRoot: distRoot, vendors });
      const out = readFileSync(join(distRoot, "claude/foo/commands/ship.md"), "utf8");
      assert.match(out, /Run `foo:bar` first\./);
    },
  );
});

test("compile warns when a command file references a skill resolved nowhere", async () => {
  await withPluginFixture(
    {
      pluginSource: `import { definePlugin } from "#harness-kit";
export default definePlugin({ name: "foo", version: "1.0.0", description: "demo" });
`,
      extraFiles: {
        "commands/ship.md": `---\nname: ship\ndescription: x\n---\n\nRun {{skill:superpowers:ghost}}.\n`,
      },
    },
    async (srcRoot, distRoot) => {
      const warnings: string[] = [];
      await compile({
        srcRoot,
        outRoot: distRoot,
        vendors,
        onWarnings: (_file, ws) => warnings.push(...ws),
      });
      const out = readFileSync(join(distRoot, "claude/foo/commands/ship.md"), "utf8");
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
      pluginSource: `import { definePlugin } from "#harness-kit";
export default definePlugin({ name: "foo", version: "1.0.0", description: "demo" });
`,
      extraFiles: {
        "shared/notes.md": "# Notes\n",
        "agents/reviewer.md": `---\nname: reviewer\ndescription: x\n---\n\nsee {{ref:../shared/notes.md}}\n`,
      },
    },
    async (srcRoot, distRoot) => {
      await compile({ srcRoot, outRoot: distRoot, vendors });
      const out = readFileSync(join(distRoot, "claude/foo/agents/reviewer.md"), "utf8");
      assert.match(out, /see `\.\.\/shared\/notes\.md`/);
    },
  );
});

test("compile builds the markdown-only fixture end-to-end", async () => {
  await withTempDist(async (dist) => {
    await compile({ srcRoot: mdSourceRoot, outRoot: dist, vendors });

    const skillPath = join(dist, "claude/foo/skills/bar/SKILL.md");
    assert.ok(existsSync(skillPath), `expected ${skillPath} to exist`);

    const content = readFileSync(skillPath, "utf8");
    assert.match(content, /^---\nname: bar\ndescription: [^\n]+\n---\n/);
    assert.match(content, /Inlined verbatim from preamble\.md\./);
    assert.match(content, /`superpowers:test-driven-development`/);
    assert.doesNotMatch(content, /\{\{include:/);
    assert.doesNotMatch(content, /\{\{skill:/);

    const preambleCopy = join(dist, "claude/foo/skills/bar/preamble.md");
    assert.ok(!existsSync(preambleCopy), `did not expect ${preambleCopy} to exist`);
  });
});

test("compile substitutes {{command:plugin:name}} as `/plugin:name` for a discovered local command", async () => {
  await withSkillFixture(
    {
      skillSource: SKILL_TS_BARE,
      bodyMd: "run {{command:dev-tools:open-pr}} to ship\n",
    },
    async (srcRoot, distRoot) => {
      makeStubCommand(srcRoot, "dev-tools", "open-pr");
      await compile({ srcRoot, outRoot: distRoot, vendors });
      const out = readFileSync(join(distRoot, "claude/foo/skills/bar/SKILL.md"), "utf8");
      assert.match(out, /run `\/dev-tools:open-pr` to ship/);
    },
  );
});

test("compile warns but still renders when {{command:...}} resolves to neither a local nor an installed command", async () => {
  await withSkillFixture(
    {
      skillSource: SKILL_TS_BARE,
      bodyMd: "see {{command:dev-tools:ghost}}\n",
    },
    async (srcRoot, distRoot) => {
      const warnings: string[] = [];
      await compile({
        srcRoot,
        outRoot: distRoot,
        vendors,
        onWarnings: (_file, ws) => warnings.push(...ws),
      });
      const out = readFileSync(join(distRoot, "claude/foo/skills/bar/SKILL.md"), "utf8");
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
      skillSource: SKILL_TS_BARE,
      bodyMd: "{{command:lonelyid}}\n",
    },
    async (srcRoot, distRoot) => {
      await assert.rejects(compile({ srcRoot, outRoot: distRoot, vendors }), /<plugin>:<command>/);
    },
  );
});

test("compile substitutes {{agent:plugin:name}} as the scoped `plugin:name` handle for a discovered local agent", async () => {
  await withSkillFixture(
    {
      skillSource: SKILL_TS_BARE,
      bodyMd: "dispatch {{agent:dev-tools:code-reviewer}} for review\n",
    },
    async (srcRoot, distRoot) => {
      makeStubAgent(srcRoot, "dev-tools", "code-reviewer");
      await compile({ srcRoot, outRoot: distRoot, vendors });
      const out = readFileSync(join(distRoot, "claude/foo/skills/bar/SKILL.md"), "utf8");
      assert.match(out, /dispatch `dev-tools:code-reviewer` for review/);
    },
  );
});

test("compile warns but still renders when {{agent:...}} resolves to neither a local nor an installed agent", async () => {
  await withSkillFixture(
    {
      skillSource: SKILL_TS_BARE,
      bodyMd: "see {{agent:dev-tools:ghost}}\n",
    },
    async (srcRoot, distRoot) => {
      const warnings: string[] = [];
      await compile({
        srcRoot,
        outRoot: distRoot,
        vendors,
        onWarnings: (_file, ws) => warnings.push(...ws),
      });
      const out = readFileSync(join(distRoot, "claude/foo/skills/bar/SKILL.md"), "utf8");
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
      skillSource: SKILL_TS_BARE,
      bodyMd: "{{agent:lonelyid}}\n",
    },
    async (srcRoot, distRoot) => {
      await assert.rejects(compile({ srcRoot, outRoot: distRoot, vendors }), /<plugin>:<agent>/);
    },
  );
});

test("compile resolves {{agent:...}} against an installed plugin and renders the scoped handle", async () => {
  await withInstalledSources([{ plugin: "dev-tools", agent: "code-reviewer" }], async (sources) => {
    await withSkillFixture(
      {
        skillSource: SKILL_TS_BARE,
        bodyMd: "dispatch {{agent:dev-tools:code-reviewer}} for review\n",
      },
      async (srcRoot, distRoot) => {
        const warnings: string[] = [];
        await compile({
          srcRoot,
          outRoot: distRoot,
          vendors,
          sources,
          onWarnings: (_file, ws) => warnings.push(...ws),
        });
        const out = readFileSync(join(distRoot, "claude/foo/skills/bar/SKILL.md"), "utf8");
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
        skillSource: SKILL_TS_BARE,
        bodyMd: "run {{command:dev-tools:open-pr}} after merging\n",
      },
      async (srcRoot, distRoot) => {
        await compile({ srcRoot, outRoot: distRoot, vendors, sources });
        const out = readFileSync(join(distRoot, "claude/foo/skills/bar/SKILL.md"), "utf8");
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
          skillSource: SKILL_TS_BARE,
          bodyMd: "dispatch {{agent:code-simplifier:code-simplifier}} after coding\n",
        },
        async (srcRoot, distRoot) => {
          await compile({ srcRoot, outRoot: distRoot, vendors, sources });
          const out = readFileSync(join(distRoot, "claude/foo/skills/bar/SKILL.md"), "utf8");
          assert.match(out, /dispatch `code-simplifier:code-simplifier` after coding/);
        },
      );
    },
  );
});

test("compile substitutes placeholders in context files declared on the plugin", async () => {
  await withPluginFixture(
    {
      pluginSource: `import { definePlugin } from "#harness-kit";
export default definePlugin({
  name: "foo",
  version: "1.0.0",
  description: "demo",
  context: [{ file: "context/instructions.md", summary: "ok" }],
});
`,
      extraFiles: {
        "context/instructions.md": "use {{skill:foo:bar}} when needed\n",
        "skills/bar/SKILL.ts": `import { defineSkill } from "#harness-kit";
export default defineSkill({ name: "bar", description: "stub" });
`,
        "skills/bar/body.md": "# Bar\n",
      },
    },
    async (srcRoot, distRoot) => {
      await compile({ srcRoot, outRoot: distRoot, vendors });
      const out = readFileSync(join(distRoot, "claude/foo/context/instructions.md"), "utf8");
      assert.match(out, /use `foo:bar` when needed/);
    },
  );
});

test("compile warns when a context file references a skill resolved nowhere", async () => {
  await withPluginFixture(
    {
      pluginSource: `import { definePlugin } from "#harness-kit";
export default definePlugin({
  name: "foo",
  version: "1.0.0",
  description: "demo",
  context: [{ file: "context/instructions.md", summary: "ok" }],
});
`,
      extraFiles: {
        "context/instructions.md": "see {{skill:superpowers:ghost}}\n",
      },
    },
    async (srcRoot, distRoot) => {
      const warnings: string[] = [];
      await compile({
        srcRoot,
        outRoot: distRoot,
        vendors,
        onWarnings: (_file, ws) => warnings.push(...ws),
      });
      const out = readFileSync(join(distRoot, "claude/foo/context/instructions.md"), "utf8");
      assert.match(out, /see `superpowers:ghost`/);
      assert.ok(
        warnings.some((w) => w.includes("superpowers:ghost")),
        `expected an unresolved-ref warning, got:\n${warnings.join("\n")}`,
      );
    },
  );
});

test("compile substitutes a cross-marketplace {{skill:...}} in context files", async () => {
  await withPluginFixture(
    {
      pluginSource: `import { definePlugin } from "#harness-kit";
export default definePlugin({
  name: "foo",
  version: "1.0.0",
  description: "demo",
  context: [{ file: "context/instructions.md", summary: "ok" }],
});
`,
      extraFiles: {
        "context/instructions.md": "see {{skill:superpowers:tdd}} for details\n",
      },
    },
    async (srcRoot, distRoot) => {
      await compile({ srcRoot, outRoot: distRoot, vendors });
      const out = readFileSync(join(distRoot, "claude/foo/context/instructions.md"), "utf8");
      assert.match(out, /see `superpowers:tdd` for details/);
    },
  );
});

test("compile resolves {{ref:...}} in a context file relative to the context file directory", async () => {
  await withPluginFixture(
    {
      pluginSource: `import { definePlugin } from "#harness-kit";
export default definePlugin({
  name: "foo",
  version: "1.0.0",
  description: "demo",
  context: [{ file: "context/instructions.md", summary: "ok" }],
});
`,
      extraFiles: {
        "context/instructions.md": "see {{ref:./sibling.md}}\n",
        "context/sibling.md": "# Sibling\n",
      },
    },
    async (srcRoot, distRoot) => {
      await compile({ srcRoot, outRoot: distRoot, vendors });
      const out = readFileSync(join(distRoot, "claude/foo/context/instructions.md"), "utf8");
      assert.match(out, /see `\.\/sibling\.md`/);
    },
  );
});

test("compile fails when a context file has a broken {{ref:...}}", async () => {
  await withPluginFixture(
    {
      pluginSource: `import { definePlugin } from "#harness-kit";
export default definePlugin({
  name: "foo",
  version: "1.0.0",
  description: "demo",
  context: [{ file: "context/instructions.md", summary: "ok" }],
});
`,
      extraFiles: {
        "context/instructions.md": "see {{ref:./ghost.md}}\n",
      },
    },
    async (srcRoot, distRoot) => {
      await assert.rejects(
        compile({ srcRoot, outRoot: distRoot, vendors }),
        /ref.*ghost\.md.*not found/,
      );
    },
  );
});

test("compile substitutes placeholders in an undeclared .md file", async () => {
  await withPluginFixture(
    {
      pluginSource: `import { definePlugin } from "#harness-kit";
export default definePlugin({ name: "foo", version: "1.0.0", description: "demo" });
`,
      extraFiles: {
        "notes/part.md": "shared body\n",
        "notes/scratch.md": "doc {{include:./part.md}} end\n",
      },
    },
    async (srcRoot, distRoot) => {
      await compile({ srcRoot, outRoot: distRoot, vendors });
      const out = readFileSync(join(distRoot, "claude/foo/notes/scratch.md"), "utf8");
      assert.match(out, /shared body/);
      assert.doesNotMatch(out, /\{\{include/);
    },
  );
});

test("compile accepts hookRequires that point to existing local artifacts", async () => {
  await withPluginFixture(
    {
      pluginSource: `import { definePlugin } from "#harness-kit";
export default definePlugin({
  name: "foo",
  version: "1.0.0",
  description: "demo",
  hookRequires: [
    { event: "SessionStart", skill: "foo:bar" },
    { event: "UserPromptSubmit", command: "foo:open" },
    { event: "Stop", agent: "foo:rev" },
  ],
});
`,
    },
    async (srcRoot, distRoot) => {
      makeStubSkill(srcRoot, "foo", "bar");
      makeStubCommand(srcRoot, "foo", "open");
      makeStubAgent(srcRoot, "foo", "rev");
      await compile({ srcRoot, outRoot: distRoot, vendors });
      assert.ok(existsSync(join(distRoot, "claude/foo/.claude-plugin/plugin.json")));
    },
  );
});

test("compile fails when a hookRequires skill slug is not a local skill", async () => {
  await withPluginFixture(
    {
      pluginSource: `import { definePlugin } from "#harness-kit";
export default definePlugin({
  name: "foo",
  version: "1.0.0",
  description: "demo",
  hookRequires: [{ event: "SessionStart", skill: "foo:ghost" }],
});
`,
    },
    async (srcRoot, distRoot) => {
      await assert.rejects(
        compile({ srcRoot, outRoot: distRoot, vendors }),
        /hookRequires.*foo:ghost.*not a local skill/i,
      );
    },
  );
});

test("compile fails when a hookRequires command slug is not a local command", async () => {
  await withPluginFixture(
    {
      pluginSource: `import { definePlugin } from "#harness-kit";
export default definePlugin({
  name: "foo",
  version: "1.0.0",
  description: "demo",
  hookRequires: [{ event: "UserPromptSubmit", command: "foo:ghost" }],
});
`,
    },
    async (srcRoot, distRoot) => {
      await assert.rejects(
        compile({ srcRoot, outRoot: distRoot, vendors }),
        /hookRequires.*foo:ghost.*not a local command/i,
      );
    },
  );
});

test("compile fails when a hookRequires agent slug is not a local agent", async () => {
  await withPluginFixture(
    {
      pluginSource: `import { definePlugin } from "#harness-kit";
export default definePlugin({
  name: "foo",
  version: "1.0.0",
  description: "demo",
  hookRequires: [{ event: "Stop", agent: "foo:ghost" }],
});
`,
    },
    async (srcRoot, distRoot) => {
      await assert.rejects(
        compile({ srcRoot, outRoot: distRoot, vendors }),
        /hookRequires.*foo:ghost.*not a local agent/i,
      );
    },
  );
});

test("compile accepts a cross-plugin {{skill:other:bar}} reference when `other` is in dependencies", async () => {
  await withPluginFixture(
    {
      pluginSource: `import { definePlugin } from "#harness-kit";
export default definePlugin({
  name: "foo",
  version: "1.0.0",
  description: "demo",
  dependencies: ["other"],
});
`,
      extraFiles: {
        "skills/bar/SKILL.ts": `import { defineSkill } from "#harness-kit";
export default defineSkill({ name: "bar", description: "demo" });
`,
        "skills/bar/body.md": "see {{skill:other:tdd}}\n",
      },
    },
    async (srcRoot, distRoot) => {
      const otherDir = join(srcRoot, "plugins/other");
      mkdirSync(otherDir, { recursive: true });
      writeFileSync(
        join(otherDir, "PLUGIN.ts"),
        `import { definePlugin } from "#harness-kit";\nexport default definePlugin({ name: "other", version: "1.0.0", description: "demo" });\n`,
      );
      makeStubSkill(srcRoot, "other", "tdd");
      await compile({ srcRoot, outRoot: distRoot, vendors });
      assert.ok(existsSync(join(distRoot, "claude/foo/skills/bar/SKILL.md")));
    },
  );
});

test("compile fails on a cross-plugin {{skill:other:bar}} when `other` is not in dependencies", async () => {
  await withPluginFixture(
    {
      pluginSource: `import { definePlugin } from "#harness-kit";
export default definePlugin({ name: "foo", version: "1.0.0", description: "demo" });
`,
      extraFiles: {
        "skills/bar/SKILL.ts": `import { defineSkill } from "#harness-kit";
export default defineSkill({ name: "bar", description: "demo" });
`,
        "skills/bar/body.md": "see {{skill:other:tdd}}\n",
      },
    },
    async (srcRoot, distRoot) => {
      const otherDir = join(srcRoot, "plugins/other");
      mkdirSync(otherDir, { recursive: true });
      writeFileSync(
        join(otherDir, "PLUGIN.ts"),
        `import { definePlugin } from "#harness-kit";\nexport default definePlugin({ name: "other", version: "1.0.0", description: "demo" });\n`,
      );
      makeStubSkill(srcRoot, "other", "tdd");
      await assert.rejects(
        compile({ srcRoot, outRoot: distRoot, vendors }),
        /cross-plugin.*other.*dependencies/i,
      );
    },
  );
});

test("compile fails on a cross-plugin {{command:other:open}} when `other` is not in dependencies", async () => {
  await withPluginFixture(
    {
      pluginSource: `import { definePlugin } from "#harness-kit";
export default definePlugin({ name: "foo", version: "1.0.0", description: "demo" });
`,
      extraFiles: {
        "skills/bar/SKILL.ts": `import { defineSkill } from "#harness-kit";
export default defineSkill({ name: "bar", description: "demo" });
`,
        "skills/bar/body.md": "run {{command:other:open}}\n",
      },
    },
    async (srcRoot, distRoot) => {
      const otherDir = join(srcRoot, "plugins/other");
      mkdirSync(otherDir, { recursive: true });
      writeFileSync(
        join(otherDir, "PLUGIN.ts"),
        `import { definePlugin } from "#harness-kit";\nexport default definePlugin({ name: "other", version: "1.0.0", description: "demo" });\n`,
      );
      makeStubCommand(srcRoot, "other", "open");
      await assert.rejects(
        compile({ srcRoot, outRoot: distRoot, vendors }),
        /cross-plugin.*other.*dependencies/i,
      );
    },
  );
});

test("compile permits same-plugin {{skill:foo:bar}} reference without any dependencies declared", async () => {
  await withPluginFixture(
    {
      pluginSource: `import { definePlugin } from "#harness-kit";
export default definePlugin({ name: "foo", version: "1.0.0", description: "demo" });
`,
      extraFiles: {
        "skills/bar/SKILL.ts": `import { defineSkill } from "#harness-kit";
export default defineSkill({ name: "bar", description: "demo" });
`,
        "skills/bar/body.md": "no self-loop, but: {{skill:foo:other-skill}}\n",
        "skills/other-skill/SKILL.ts": `import { defineSkill } from "#harness-kit";
export default defineSkill({ name: "other-skill", description: "demo" });
`,
        "skills/other-skill/body.md": "# Other\n",
      },
    },
    async (srcRoot, distRoot) => {
      await compile({ srcRoot, outRoot: distRoot, vendors });
      assert.ok(existsSync(join(distRoot, "claude/foo/skills/bar/SKILL.md")));
    },
  );
});

test("compile does NOT enforce dependencies on a {{skill:...}} that resolves outside the marketplace", async () => {
  await withInstalledSources([{ plugin: "other", skill: "tdd" }], async (sources) => {
    await withPluginFixture(
      {
        pluginSource: `import { definePlugin } from "#harness-kit";
export default definePlugin({ name: "foo", version: "1.0.0", description: "demo" });
`,
        extraFiles: {
          "skills/bar/SKILL.ts": `import { defineSkill } from "#harness-kit";
export default defineSkill({ name: "bar", description: "demo" });
`,
          "skills/bar/body.md": "external ref: {{skill:other:tdd}}\n",
        },
      },
      async (srcRoot, distRoot) => {
        await compile({ srcRoot, outRoot: distRoot, vendors, sources });
        const out = readFileSync(join(distRoot, "claude/foo/skills/bar/SKILL.md"), "utf8");
        assert.match(out, /external ref: `other:tdd`/);
      },
    );
  });
});

async function withRawPluginJson<T>(
  manifest: Record<string, unknown>,
  fn: (srcRoot: string, distRoot: string) => Promise<T>,
): Promise<T> {
  const sandbox = mkdtempSync(join(fixturesRoot, "_tmp_"));
  const srcRoot = join(sandbox, "src");
  const distRoot = mkdtempSync(join(tmpdir(), "harness-kit-dist-"));
  const pluginName = manifest["name"] as string;
  const pluginDir = join(srcRoot, "plugins", pluginName);
  mkdirSync(join(pluginDir, ".claude-plugin"), { recursive: true });
  writeFileSync(
    join(pluginDir, ".claude-plugin/plugin.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  mkdirSync(join(srcRoot, ".claude-plugin"), { recursive: true });
  writeFileSync(
    join(srcRoot, ".claude-plugin/marketplace.json"),
    JSON.stringify(
      {
        name: "test-marketplace",
        owner: { name: "harness-kit-tests" },
        plugins: [{ name: pluginName, source: `./plugins/${pluginName}` }],
      },
      null,
      2,
    ) + "\n",
  );
  return fn(srcRoot, distRoot).finally(() => {
    rmSync(sandbox, { recursive: true, force: true });
    rmSync(distRoot, { recursive: true, force: true });
  });
}

test("compile preserves upstream passthrough keys in emitted plugin.json", async () => {
  await withRawPluginJson(
    {
      name: "foo",
      version: "1.0.0",
      description: "demo",
      category: "development",
      tags: ["ai", "tools"],
      mcpServers: { example: { command: "node", args: ["server.js"] } },
    },
    async (srcRoot, distRoot) => {
      await compile({ srcRoot, outRoot: distRoot, vendors });
      const emitted = JSON.parse(
        readFileSync(join(distRoot, "claude/foo/.claude-plugin/plugin.json"), "utf8"),
      ) as Record<string, unknown>;
      assert.equal(emitted["category"], "development");
      assert.deepEqual(emitted["tags"], ["ai", "tools"]);
      assert.ok(emitted["mcpServers"]);
    },
  );
});

test("compile accepts object-form dependencies and enforces cross-plugin invariant by name", async () => {
  const sandbox = mkdtempSync(join(fixturesRoot, "_tmp_"));
  const srcRoot = join(sandbox, "src");
  const distRoot = mkdtempSync(join(tmpdir(), "harness-kit-dist-"));
  try {
    const fooDir = join(srcRoot, "plugins/foo");
    mkdirSync(join(fooDir, ".claude-plugin"), { recursive: true });
    writeFileSync(
      join(fooDir, ".claude-plugin/plugin.json"),
      JSON.stringify(
        {
          name: "foo",
          version: "1.0.0",
          description: "demo",
          dependencies: [{ name: "other", marketplace: "claude-plugins-official" }],
        },
        null,
        2,
      ) + "\n",
    );
    const skillDir = join(fooDir, "skills/bar");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.ts"),
      `import { defineSkill } from "#harness-kit";
export default defineSkill({ name: "bar", description: "demo" });
`,
    );
    writeFileSync(join(skillDir, "body.md"), "see {{skill:other:tdd}}\n");

    const otherDir = join(srcRoot, "plugins/other");
    mkdirSync(join(otherDir, ".claude-plugin"), { recursive: true });
    writeFileSync(
      join(otherDir, ".claude-plugin/plugin.json"),
      JSON.stringify({ name: "other", version: "1.0.0", description: "demo" }, null, 2) + "\n",
    );
    makeStubSkill(srcRoot, "other", "tdd");

    mkdirSync(join(srcRoot, ".claude-plugin"), { recursive: true });
    writeFileSync(
      join(srcRoot, ".claude-plugin/marketplace.json"),
      JSON.stringify(
        {
          name: "test-marketplace",
          owner: { name: "harness-kit-tests" },
          plugins: [
            { name: "foo", source: "./plugins/foo" },
            { name: "other", source: "./plugins/other" },
          ],
        },
        null,
        2,
      ) + "\n",
    );

    await compile({ srcRoot, outRoot: distRoot, vendors });
    assert.ok(existsSync(join(distRoot, "claude/foo/skills/bar/SKILL.md")));
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
    rmSync(distRoot, { recursive: true, force: true });
  }
});
