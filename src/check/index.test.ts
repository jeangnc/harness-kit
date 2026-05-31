import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { check } from "./index.js";
import type { PluginSource } from "../installed.js";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

interface SkillFile {
  readonly plugin: string;
  readonly skill: string;
  readonly body: string;
}

async function withSrcFixture<T>(
  files: readonly SkillFile[],
  fn: (srcRoot: string) => Promise<T>,
): Promise<T> {
  const sandbox = mkdtempSync(join(repoRoot, ".test-tmp-check-"));
  const srcRoot = join(sandbox, "src");
  for (const file of files) {
    const skillDir = join(srcRoot, "plugins", file.plugin, "skills", file.skill);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      `---\nname: ${file.skill}\ndescription: x\n---\n\n${file.body}`,
    );
  }
  return fn(srcRoot).finally(() => rmSync(sandbox, { recursive: true, force: true }));
}

interface LocalCompanionFile {
  readonly file: string;
  readonly body: string;
}

interface LocalSkillFile {
  readonly plugin: string;
  readonly skill: string;
  readonly body: string;
  readonly companions?: readonly LocalCompanionFile[];
}

interface LocalCommandFile {
  readonly plugin: string;
  readonly command: string;
  readonly body?: string;
}

interface LocalAgentFile {
  readonly plugin: string;
  readonly agent: string;
  readonly body?: string;
}

interface LocalFixture {
  readonly skills?: readonly LocalSkillFile[];
  readonly commands?: readonly LocalCommandFile[];
  readonly agents?: readonly LocalAgentFile[];
  readonly dependencies?: Readonly<Record<string, readonly string[]>>;
}

async function withLocalSrcFixture<T>(
  fixture: LocalFixture,
  fn: (srcRoot: string) => Promise<T>,
): Promise<T> {
  const sandbox = mkdtempSync(join(repoRoot, ".test-tmp-check-local-"));
  const srcRoot = join(sandbox, "src");
  const pluginNames = new Set<string>();
  for (const s of fixture.skills ?? []) pluginNames.add(s.plugin);
  for (const c of fixture.commands ?? []) pluginNames.add(c.plugin);
  for (const a of fixture.agents ?? []) pluginNames.add(a.plugin);
  for (const p of Object.keys(fixture.dependencies ?? {})) pluginNames.add(p);
  for (const plugin of pluginNames) {
    const pluginDir = join(srcRoot, "plugins", plugin);
    const manifestDir = join(pluginDir, ".claude-plugin");
    mkdirSync(manifestDir, { recursive: true });
    const manifest: Record<string, unknown> = {
      name: plugin,
      version: "0.0.1",
      description: "fixture",
    };
    const deps = fixture.dependencies?.[plugin];
    if (deps && deps.length > 0) manifest["dependencies"] = deps;
    writeFileSync(join(manifestDir, "plugin.json"), JSON.stringify(manifest, null, 2) + "\n");
  }
  for (const file of fixture.skills ?? []) {
    const skillDir = join(srcRoot, "plugins", file.plugin, "skills", file.skill);
    mkdirSync(skillDir, { recursive: true });
    const companions = file.companions ?? [];
    const lines = ["---", `name: ${file.skill}`, "description: x"];
    if (companions.length > 0) {
      lines.push("companions:");
      for (const c of companions) lines.push(`  - file: ${c.file}`, `    summary: ${c.file}`);
    }
    lines.push("---", "", "");
    writeFileSync(join(skillDir, "SKILL.md"), `${lines.join("\n")}${file.body}`);
    for (const companion of companions) {
      writeFileSync(join(skillDir, companion.file), companion.body);
    }
  }
  for (const file of fixture.commands ?? []) {
    const dir = join(srcRoot, "plugins", file.plugin, "commands");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${file.command}.md`),
      `---\nname: ${file.command}\ndescription: x\n---\n\n${file.body ?? ""}`,
    );
  }
  for (const file of fixture.agents ?? []) {
    const dir = join(srcRoot, "plugins", file.plugin, "agents");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${file.agent}.md`),
      `---\nname: ${file.agent}\ndescription: x\n---\n\n${file.body ?? ""}`,
    );
  }
  const marketplaceDir = join(srcRoot, ".claude-plugin");
  mkdirSync(marketplaceDir, { recursive: true });
  writeFileSync(
    join(marketplaceDir, "marketplace.json"),
    JSON.stringify(
      {
        name: "check-local-test",
        owner: { name: "harness-kit-tests" },
        plugins: [...pluginNames].map((p) => ({ name: p, source: `./plugins/${p}` })),
      },
      null,
      2,
    ) + "\n",
  );
  return fn(srcRoot).finally(() => rmSync(sandbox, { recursive: true, force: true }));
}

interface InstalledArtifact {
  readonly plugin: string;
  readonly skill?: string;
  readonly command?: string;
  readonly agent?: string;
}

async function withInstalledFixture<T>(
  installed: readonly InstalledArtifact[],
  fn: (sources: readonly PluginSource[]) => Promise<T>,
): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "harness-kit-check-installed-"));
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

test("check returns no violations when an installed skill ref resolves", async () => {
  await withInstalledFixture([{ plugin: "superpowers", skill: "tdd" }], async (sources) => {
    await withSrcFixture(
      [{ plugin: "foo", skill: "bar", body: "see {{skill:superpowers:tdd}}\n" }],
      async (srcRoot) => {
        const result = await check({ srcRoot, sources });
        assert.deepEqual([...result.violations], []);
        assert.equal(result.checkedFiles, 1);
        assert.equal(result.indexedSources[0]?.skillCount, 1);
      },
    );
  });
});

test("check reports an unresolved skill ref when no installed source has the referenced skill", async () => {
  await withInstalledFixture([{ plugin: "superpowers", skill: "tdd" }], async (sources) => {
    await withSrcFixture(
      [{ plugin: "foo", skill: "bar", body: "see {{skill:nope:missing}}\n" }],
      async (srcRoot) => {
        const result = await check({ srcRoot, sources });
        assert.equal(result.violations.length, 1);
        assert.equal(result.violations[0]!.kind, "unresolved");
        assert.match(result.violations[0]!.message, /not found/i);
        assert.match(result.violations[0]!.token, /nope:missing/);
      },
    );
  });
});

test("check reports a malformed skill ref when value does not match <plugin>:<skill>", async () => {
  await withInstalledFixture([], async (sources) => {
    await withSrcFixture(
      [{ plugin: "foo", skill: "bar", body: "see {{skill:lonelyid}}\n" }],
      async (srcRoot) => {
        const result = await check({ srcRoot, sources });
        assert.equal(result.violations.length, 1);
        assert.equal(result.violations[0]!.kind, "malformed");
      },
    );
  });
});

test("check suggests the closest match when an unresolved skill id is a near-miss", async () => {
  await withInstalledFixture([{ plugin: "superpowers", skill: "tdd" }], async (sources) => {
    await withSrcFixture(
      [{ plugin: "foo", skill: "bar", body: "see {{skill:supperpowers:tdd}}\n" }],
      async (srcRoot) => {
        const result = await check({ srcRoot, sources });
        assert.equal(result.violations.length, 1);
        assert.match(result.violations[0]!.message, /superpowers:tdd/);
      },
    );
  });
});

test("check reports line:col into the source file", async () => {
  await withInstalledFixture([], async (sources) => {
    await withSrcFixture(
      [
        {
          plugin: "foo",
          skill: "bar",
          body: "line one\nline two with {{skill:nope:miss}} ref\n",
        },
      ],
      async (srcRoot) => {
        const result = await check({ srcRoot, sources });
        const violation = result.violations[0]!;
        assert.equal(violation.line, 7);
        assert.equal(typeof violation.column, "number");
        assert.ok(violation.column > 1);
      },
    );
  });
});

test("check counts each scanned skill body as a checked file", async () => {
  await withInstalledFixture([{ plugin: "superpowers", skill: "tdd" }], async (sources) => {
    await withSrcFixture(
      [
        { plugin: "foo", skill: "bar", body: "{{skill:superpowers:tdd}}\n" },
        { plugin: "foo", skill: "baz", body: "no refs\n" },
      ],
      async (srcRoot) => {
        const result = await check({ srcRoot, sources });
        assert.equal(result.checkedFiles, 2);
        assert.deepEqual([...result.violations], []);
      },
    );
  });
});

test("check works with TS-authored skills (body in body.md)", async () => {
  const sandbox = mkdtempSync(join(repoRoot, ".test-tmp-check-ts-"));
  const srcRoot = join(sandbox, "src");
  const skillDir = join(srcRoot, "plugins/foo/skills/bar");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.ts"),
    `import { defineSkill } from "#harness-kit";\nexport default defineSkill({ name: "bar", description: "x" });\n`,
  );
  writeFileSync(join(skillDir, "body.md"), "see {{skill:nope:missing}}\n");
  try {
    await withInstalledFixture([], async (sources) => {
      const result = await check({ srcRoot, sources });
      assert.equal(result.violations.length, 1);
      assert.equal(result.violations[0]!.kind, "unresolved");
    });
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("check returns no violations when a command ref resolves to an installed command", async () => {
  await withInstalledFixture([{ plugin: "dev-tools", command: "open-pr" }], async (sources) => {
    await withSrcFixture(
      [{ plugin: "foo", skill: "bar", body: "run {{command:dev-tools:open-pr}}\n" }],
      async (srcRoot) => {
        const result = await check({ srcRoot, sources });
        assert.deepEqual([...result.violations], []);
      },
    );
  });
});

test("check reports an unresolved command ref when no installed plugin has the command", async () => {
  await withInstalledFixture([{ plugin: "dev-tools", command: "open-pr" }], async (sources) => {
    await withSrcFixture(
      [{ plugin: "foo", skill: "bar", body: "run {{command:dev-tools:ghost}}\n" }],
      async (srcRoot) => {
        const result = await check({ srcRoot, sources });
        assert.equal(result.violations.length, 1);
        assert.equal(result.violations[0]!.kind, "unresolved");
        assert.match(result.violations[0]!.token, /command:dev-tools:ghost/);
      },
    );
  });
});

test("check suggests the closest command match when a command id is a near-miss", async () => {
  await withInstalledFixture([{ plugin: "dev-tools", command: "open-pr" }], async (sources) => {
    await withSrcFixture(
      [{ plugin: "foo", skill: "bar", body: "run {{command:dev-tools:open-prs}}\n" }],
      async (srcRoot) => {
        const result = await check({ srcRoot, sources });
        assert.equal(result.violations.length, 1);
        assert.match(result.violations[0]!.message, /dev-tools:open-pr/);
      },
    );
  });
});

test("check does not cross-suggest a skill id for an unresolved command ref", async () => {
  await withInstalledFixture([{ plugin: "dev-tools", skill: "open-pr" }], async (sources) => {
    await withSrcFixture(
      [{ plugin: "foo", skill: "bar", body: "run {{command:dev-tools:open-pr}}\n" }],
      async (srcRoot) => {
        const result = await check({ srcRoot, sources });
        assert.equal(result.violations.length, 1);
        assert.equal(result.violations[0]!.kind, "unresolved");
        assert.doesNotMatch(result.violations[0]!.message, /did you mean/);
      },
    );
  });
});

test("check returns no violations when an agent ref resolves to an installed agent", async () => {
  await withInstalledFixture([{ plugin: "dev-tools", agent: "code-reviewer" }], async (sources) => {
    await withSrcFixture(
      [{ plugin: "foo", skill: "bar", body: "dispatch {{agent:dev-tools:code-reviewer}}\n" }],
      async (srcRoot) => {
        const result = await check({ srcRoot, sources });
        assert.deepEqual([...result.violations], []);
      },
    );
  });
});

test("check reports an unresolved agent ref when no installed plugin has the agent", async () => {
  await withInstalledFixture([{ plugin: "dev-tools", agent: "code-reviewer" }], async (sources) => {
    await withSrcFixture(
      [{ plugin: "foo", skill: "bar", body: "dispatch {{agent:dev-tools:ghost}}\n" }],
      async (srcRoot) => {
        const result = await check({ srcRoot, sources });
        assert.equal(result.violations.length, 1);
        assert.equal(result.violations[0]!.kind, "unresolved");
        assert.match(result.violations[0]!.token, /agent:dev-tools:ghost/);
      },
    );
  });
});

test("check reports a malformed command ref when value does not match <plugin>:<command>", async () => {
  await withInstalledFixture([], async (sources) => {
    await withSrcFixture(
      [{ plugin: "foo", skill: "bar", body: "{{command:lonely}}\n" }],
      async (srcRoot) => {
        const result = await check({ srcRoot, sources });
        assert.equal(result.violations.length, 1);
        assert.equal(result.violations[0]!.kind, "malformed");
      },
    );
  });
});

test("check reports a malformed agent ref when value does not match <plugin>:<agent>", async () => {
  await withInstalledFixture([], async (sources) => {
    await withSrcFixture(
      [{ plugin: "foo", skill: "bar", body: "{{agent:lonely}}\n" }],
      async (srcRoot) => {
        const result = await check({ srcRoot, sources });
        assert.equal(result.violations.length, 1);
        assert.equal(result.violations[0]!.kind, "malformed");
      },
    );
  });
});

test("check, in local mode, resolves a {{skill:}} ref to a local plugin's skill", async () => {
  await withLocalSrcFixture(
    {
      skills: [
        { plugin: "foo", skill: "bar", body: "see {{skill:foo:bar}}\n" },
        { plugin: "foo", skill: "baz", body: "no refs\n" },
      ],
    },
    async (srcRoot) => {
      const result = await check({ srcRoot, mode: "local" });
      assert.deepEqual([...result.violations], []);
    },
  );
});

test("check, in local mode, reports an unresolved {{skill:}} when no local plugin has the skill", async () => {
  await withLocalSrcFixture(
    {
      skills: [{ plugin: "foo", skill: "bar", body: "see {{skill:nope:missing}}\n" }],
    },
    async (srcRoot) => {
      const result = await check({ srcRoot, mode: "local" });
      assert.equal(result.violations.length, 1);
      assert.equal(result.violations[0]!.kind, "unresolved");
      assert.match(result.violations[0]!.token, /skill:nope:missing/);
    },
  );
});

test("check, in local mode, suggests the closest skill match on a near-miss", async () => {
  await withLocalSrcFixture(
    {
      skills: [
        { plugin: "foo", skill: "bar", body: "see {{skill:foo:baz}}\n" },
        { plugin: "foo", skill: "baz", body: "target\n" },
      ],
    },
    async (srcRoot) => {
      const result = await check({
        srcRoot,
        mode: "local",
      });
      assert.deepEqual([...result.violations], []);
    },
  );
});

test("check, in local mode, resolves a {{command:}} ref to a local plugin's command", async () => {
  await withLocalSrcFixture(
    {
      skills: [{ plugin: "foo", skill: "bar", body: "run {{command:foo:open-pr}}\n" }],
      commands: [{ plugin: "foo", command: "open-pr" }],
    },
    async (srcRoot) => {
      const result = await check({ srcRoot, mode: "local" });
      assert.deepEqual([...result.violations], []);
    },
  );
});

test("check, in local mode, reports an unresolved {{command:}} when no local plugin has the command", async () => {
  await withLocalSrcFixture(
    {
      skills: [{ plugin: "foo", skill: "bar", body: "run {{command:foo:ghost}}\n" }],
      commands: [{ plugin: "foo", command: "open-pr" }],
    },
    async (srcRoot) => {
      const result = await check({ srcRoot, mode: "local" });
      assert.equal(result.violations.length, 1);
      assert.equal(result.violations[0]!.kind, "unresolved");
      assert.match(result.violations[0]!.token, /command:foo:ghost/);
    },
  );
});

test("check, in local mode, resolves a {{agent:}} ref to a local plugin's agent", async () => {
  await withLocalSrcFixture(
    {
      skills: [{ plugin: "foo", skill: "bar", body: "dispatch {{agent:foo:reviewer}}\n" }],
      agents: [{ plugin: "foo", agent: "reviewer" }],
    },
    async (srcRoot) => {
      const result = await check({ srcRoot, mode: "local" });
      assert.deepEqual([...result.violations], []);
    },
  );
});

test("check, in local mode, reports an unresolved {{agent:}} when no local plugin has the agent", async () => {
  await withLocalSrcFixture(
    {
      skills: [{ plugin: "foo", skill: "bar", body: "dispatch {{agent:foo:ghost}}\n" }],
      agents: [{ plugin: "foo", agent: "reviewer" }],
    },
    async (srcRoot) => {
      const result = await check({ srcRoot, mode: "local" });
      assert.equal(result.violations.length, 1);
      assert.equal(result.violations[0]!.kind, "unresolved");
      assert.match(result.violations[0]!.token, /agent:foo:ghost/);
    },
  );
});

test("check, in local mode, scans command bodies for placeholder violations", async () => {
  await withLocalSrcFixture(
    {
      commands: [{ plugin: "foo", command: "do-thing", body: "see {{skill:foo:ghost}}\n" }],
    },
    async (srcRoot) => {
      const result = await check({ srcRoot, mode: "local" });
      assert.equal(result.violations.length, 1);
      assert.equal(result.violations[0]!.kind, "unresolved");
      assert.match(result.violations[0]!.token, /skill:foo:ghost/);
    },
  );
});

test("check, in local mode, scans agent bodies for placeholder violations", async () => {
  await withLocalSrcFixture(
    {
      agents: [{ plugin: "foo", agent: "reviewer", body: "see {{skill:foo:ghost}}\n" }],
    },
    async (srcRoot) => {
      const result = await check({ srcRoot, mode: "local" });
      assert.equal(result.violations.length, 1);
      assert.equal(result.violations[0]!.kind, "unresolved");
      assert.match(result.violations[0]!.token, /skill:foo:ghost/);
    },
  );
});

test("check, in local mode, reports a malformed {{skill:}} when value does not match <plugin>:<name>", async () => {
  await withLocalSrcFixture(
    {
      skills: [{ plugin: "foo", skill: "bar", body: "see {{skill:lonely}}\n" }],
    },
    async (srcRoot) => {
      const result = await check({ srcRoot, mode: "local" });
      assert.equal(result.violations.length, 1);
      assert.equal(result.violations[0]!.kind, "malformed");
    },
  );
});

test("check, in local mode, does not perform any installed-cache reads", async () => {
  await withLocalSrcFixture(
    {
      skills: [{ plugin: "foo", skill: "bar", body: "no refs\n" }],
    },
    async (srcRoot) => {
      const result = await check({ srcRoot, mode: "local" });
      assert.equal(result.indexedSources.length, 0);
    },
  );
});

test("check, in installed mode (default), resolves {{skill:}} placeholders against the installed index", async () => {
  await withInstalledFixture([{ plugin: "superpowers", skill: "tdd" }], async (sources) => {
    await withSrcFixture(
      [{ plugin: "foo", skill: "bar", body: "see {{skill:superpowers:tdd}}\n" }],
      async (srcRoot) => {
        const result = await check({ srcRoot, sources });
        assert.deepEqual([...result.violations], []);
      },
    );
  });
});

test("check, in installed mode (default), reports an unresolved {{skill:}} not in the installed index", async () => {
  await withInstalledFixture([{ plugin: "superpowers", skill: "tdd" }], async (sources) => {
    await withSrcFixture(
      [{ plugin: "foo", skill: "bar", body: "see {{skill:foo:bar}}\n" }],
      async (srcRoot) => {
        const result = await check({ srcRoot, sources });
        assert.equal(result.violations.length, 1);
        assert.equal(result.violations[0]!.kind, "unresolved");
      },
    );
  });
});

test("check warns about a slash reference to a known command written outside a placeholder", async () => {
  await withLocalSrcFixture(
    {
      skills: [{ plugin: "foo", skill: "bar", body: "run /foo:ship directly\n" }],
      commands: [{ plugin: "foo", command: "ship", body: "x\n" }],
    },
    async (srcRoot) => {
      const result = await check({ srcRoot, mode: "local" });
      assert.deepEqual([...result.violations], []);
      assert.equal(result.warnings.length, 1);
      assert.equal(result.warnings[0]!.id, "foo:ship");
      assert.equal(result.warnings[0]!.prefix, "command");
    },
  );
});

test("check does not warn when a known skill is referenced through a placeholder", async () => {
  await withLocalSrcFixture(
    {
      skills: [
        { plugin: "foo", skill: "bar", body: "see {{skill:foo:baz}}\n" },
        { plugin: "foo", skill: "baz", body: "x\n" },
      ],
    },
    async (srcRoot) => {
      const result = await check({ srcRoot, mode: "local" });
      assert.deepEqual([...result.warnings], []);
    },
  );
});

test("check validates placeholder references inside a declared companion file", async () => {
  await withLocalSrcFixture(
    {
      skills: [
        {
          plugin: "foo",
          skill: "bar",
          body: "x\n",
          companions: [{ file: "details.md", body: "see {{skill:foo:ghost}}\n" }],
        },
      ],
    },
    async (srcRoot) => {
      const result = await check({ srcRoot, mode: "local" });
      assert.equal(result.violations.length, 1);
      assert.equal(result.violations[0]!.kind, "unresolved");
      assert.match(result.violations[0]!.file, /details\.md$/);
    },
  );
});

test("check warns about a bypass reference inside a declared companion file", async () => {
  await withLocalSrcFixture(
    {
      skills: [
        {
          plugin: "foo",
          skill: "bar",
          body: "x\n",
          companions: [{ file: "details.md", body: "ask @foo:bar directly\n" }],
        },
      ],
      agents: [{ plugin: "foo", agent: "bar", body: "y\n" }],
    },
    async (srcRoot) => {
      const result = await check({ srcRoot, mode: "local" });
      assert.equal(result.warnings.length, 1);
      assert.equal(result.warnings[0]!.id, "foo:bar");
      assert.equal(result.warnings[0]!.prefix, "agent");
      assert.match(result.warnings[0]!.file, /details\.md$/);
    },
  );
});

test("check fails with a clear error when a declared companion file is missing on disk", async () => {
  const sandbox = mkdtempSync(join(repoRoot, ".test-tmp-check-missing-"));
  const srcRoot = join(sandbox, "src");
  const skillDir = join(srcRoot, "plugins/foo/skills/bar");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.md"),
    "---\nname: bar\ndescription: x\ncompanions:\n  - file: gone.md\n    summary: gone\n---\n\nbody\n",
  );
  try {
    await withInstalledFixture([], async (sources) => {
      await assert.rejects(
        check({ srcRoot, sources }),
        /companion "gone\.md" declared but not present/,
      );
    });
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("check, in all mode, validates skill refs against the union of local and installed", async () => {
  await withInstalledFixture([{ plugin: "superpowers", skill: "tdd" }], async (sources) => {
    await withLocalSrcFixture(
      {
        skills: [
          { plugin: "foo", skill: "bar", body: "{{skill:nope:missing}} {{skill:foo:ghost}}\n" },
        ],
      },
      async (srcRoot) => {
        const result = await check({ srcRoot, mode: "all", sources });
        assert.equal(result.violations.length, 2);
        const tokens = result.violations.map((v) => v.token).sort();
        assert.match(tokens[0]!, /skill:foo:ghost|skill:nope:missing/);
        assert.match(tokens[1]!, /skill:foo:ghost|skill:nope:missing/);
      },
    );
  });
});
