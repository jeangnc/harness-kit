import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { check } from "./index.js";
import type { PluginSource } from "../installed.js";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

const NO_INSTALLED: readonly PluginSource[] = [];

interface LocalCompanionFile {
  readonly file: string;
  readonly body: string;
  readonly summary?: string;
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
      for (const c of companions) {
        lines.push(`  - file: ${c.file}`, `    summary: ${JSON.stringify(c.summary ?? c.file)}`);
      }
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

test("check resolves a {{skill:}} ref to an installed plugin's skill", async () => {
  await withInstalledFixture([{ plugin: "superpowers", skill: "tdd" }], async (sources) => {
    await withLocalSrcFixture(
      { skills: [{ plugin: "foo", skill: "bar", body: "see {{skill:superpowers:tdd}}\n" }] },
      async (srcRoot) => {
        const result = await check({ srcRoot, sources });
        assert.deepEqual([...result.violations], []);
        assert.deepEqual([...result.warnings], []);
        assert.equal(result.checkedFiles, 1);
        assert.equal(result.indexedSources[0]?.skillCount, 1);
      },
    );
  });
});

test("check warns, not fails, on an unresolved external skill ref", async () => {
  await withInstalledFixture([{ plugin: "superpowers", skill: "tdd" }], async (sources) => {
    await withLocalSrcFixture(
      { skills: [{ plugin: "foo", skill: "bar", body: "see {{skill:nope:missing}}\n" }] },
      async (srcRoot) => {
        const result = await check({ srcRoot, sources });
        assert.deepEqual([...result.violations], []);
        assert.equal(result.warnings.length, 1);
        const warning = result.warnings[0]!;
        assert.equal(warning.kind, "unresolved-external");
        assert.match(warning.message, /not found among installed plugins/i);
        assert.match(warning.token, /nope:missing/);
      },
    );
  });
});

test("check fails on an unresolved internal skill ref", async () => {
  await withInstalledFixture([], async (sources) => {
    await withLocalSrcFixture(
      { skills: [{ plugin: "foo", skill: "bar", body: "see {{skill:foo:ghost}}\n" }] },
      async (srcRoot) => {
        const result = await check({ srcRoot, sources });
        assert.equal(result.violations.length, 1);
        assert.equal(result.violations[0]!.kind, "unresolved");
        assert.match(result.violations[0]!.message, /not found in this marketplace/i);
        assert.match(result.violations[0]!.token, /foo:ghost/);
        assert.deepEqual([...result.warnings], []);
      },
    );
  });
});

test("check reports a malformed skill ref when value does not match <plugin>:<skill>", async () => {
  await withInstalledFixture([], async (sources) => {
    await withLocalSrcFixture(
      { skills: [{ plugin: "foo", skill: "bar", body: "see {{skill:lonelyid}}\n" }] },
      async (srcRoot) => {
        const result = await check({ srcRoot, sources });
        assert.equal(result.violations.length, 1);
        assert.equal(result.violations[0]!.kind, "malformed");
      },
    );
  });
});

test("check suggests the closest match when an unresolved external skill id is a near-miss", async () => {
  await withInstalledFixture([{ plugin: "superpowers", skill: "tdd" }], async (sources) => {
    await withLocalSrcFixture(
      { skills: [{ plugin: "foo", skill: "bar", body: "see {{skill:supperpowers:tdd}}\n" }] },
      async (srcRoot) => {
        const result = await check({ srcRoot, sources });
        assert.deepEqual([...result.violations], []);
        assert.equal(result.warnings.length, 1);
        assert.match(result.warnings[0]!.message, /superpowers:tdd/);
      },
    );
  });
});

test("check reports line:col into the source file for an external warning", async () => {
  await withInstalledFixture([], async (sources) => {
    await withLocalSrcFixture(
      {
        skills: [
          {
            plugin: "foo",
            skill: "bar",
            body: "line one\nline two with {{skill:nope:miss}} ref\n",
          },
        ],
      },
      async (srcRoot) => {
        const result = await check({ srcRoot, sources });
        const warning = result.warnings[0]!;
        assert.equal(warning.kind, "unresolved-external");
        assert.equal(warning.line, 7);
        assert.equal(typeof warning.column, "number");
        assert.ok(warning.column > 1);
      },
    );
  });
});

test("check counts each scanned skill body as a checked file", async () => {
  await withInstalledFixture([{ plugin: "superpowers", skill: "tdd" }], async (sources) => {
    await withLocalSrcFixture(
      {
        skills: [
          { plugin: "foo", skill: "bar", body: "{{skill:superpowers:tdd}}\n" },
          { plugin: "foo", skill: "baz", body: "no refs\n" },
        ],
      },
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
  writeFileSync(join(skillDir, "body.md"), "see {{skill:foo:ghost}}\n");
  const marketplaceDir = join(srcRoot, ".claude-plugin");
  mkdirSync(marketplaceDir, { recursive: true });
  writeFileSync(
    join(marketplaceDir, "marketplace.json"),
    JSON.stringify({
      name: "check-ts-test",
      owner: { name: "harness-kit-tests" },
      plugins: [{ name: "foo", source: "./plugins/foo" }],
    }),
  );
  mkdirSync(join(srcRoot, "plugins/foo/.claude-plugin"), { recursive: true });
  writeFileSync(
    join(srcRoot, "plugins/foo/.claude-plugin/plugin.json"),
    JSON.stringify({ name: "foo", version: "0.0.1", description: "x" }),
  );
  try {
    await withInstalledFixture([], async (sources) => {
      const result = await check({ srcRoot, sources });
      assert.equal(result.violations.length, 1);
      assert.equal(result.violations[0]!.kind, "unresolved");
      assert.match(result.violations[0]!.message, /not found in this marketplace/i);
    });
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("check returns no violations when a command ref resolves to an installed command", async () => {
  await withInstalledFixture([{ plugin: "dev-tools", command: "open-pr" }], async (sources) => {
    await withLocalSrcFixture(
      { skills: [{ plugin: "foo", skill: "bar", body: "run {{command:dev-tools:open-pr}}\n" }] },
      async (srcRoot) => {
        const result = await check({ srcRoot, sources });
        assert.deepEqual([...result.violations], []);
      },
    );
  });
});

test("check warns on an unresolved external command ref", async () => {
  await withInstalledFixture([{ plugin: "dev-tools", command: "open-pr" }], async (sources) => {
    await withLocalSrcFixture(
      { skills: [{ plugin: "foo", skill: "bar", body: "run {{command:dev-tools:ghost}}\n" }] },
      async (srcRoot) => {
        const result = await check({ srcRoot, sources });
        assert.deepEqual([...result.violations], []);
        assert.equal(result.warnings.length, 1);
        assert.equal(result.warnings[0]!.kind, "unresolved-external");
        assert.match(result.warnings[0]!.token, /command:dev-tools:ghost/);
      },
    );
  });
});

test("check suggests the closest command match when an external command id is a near-miss", async () => {
  await withInstalledFixture([{ plugin: "dev-tools", command: "open-pr" }], async (sources) => {
    await withLocalSrcFixture(
      { skills: [{ plugin: "foo", skill: "bar", body: "run {{command:dev-tools:open-prs}}\n" }] },
      async (srcRoot) => {
        const result = await check({ srcRoot, sources });
        assert.deepEqual([...result.violations], []);
        assert.equal(result.warnings.length, 1);
        assert.match(result.warnings[0]!.message, /dev-tools:open-pr/);
      },
    );
  });
});

test("check does not cross-suggest a skill id for an unresolved external command ref", async () => {
  await withInstalledFixture([{ plugin: "dev-tools", skill: "open-pr" }], async (sources) => {
    await withLocalSrcFixture(
      { skills: [{ plugin: "foo", skill: "bar", body: "run {{command:dev-tools:open-pr}}\n" }] },
      async (srcRoot) => {
        const result = await check({ srcRoot, sources });
        assert.deepEqual([...result.violations], []);
        assert.equal(result.warnings.length, 1);
        assert.equal(result.warnings[0]!.kind, "unresolved-external");
        assert.doesNotMatch(result.warnings[0]!.message, /did you mean/);
      },
    );
  });
});

test("check returns no violations when an agent ref resolves to an installed agent", async () => {
  await withInstalledFixture([{ plugin: "dev-tools", agent: "code-reviewer" }], async (sources) => {
    await withLocalSrcFixture(
      {
        skills: [
          { plugin: "foo", skill: "bar", body: "dispatch {{agent:dev-tools:code-reviewer}}\n" },
        ],
      },
      async (srcRoot) => {
        const result = await check({ srcRoot, sources });
        assert.deepEqual([...result.violations], []);
      },
    );
  });
});

test("check warns on an unresolved external agent ref", async () => {
  await withInstalledFixture([{ plugin: "dev-tools", agent: "code-reviewer" }], async (sources) => {
    await withLocalSrcFixture(
      { skills: [{ plugin: "foo", skill: "bar", body: "dispatch {{agent:dev-tools:ghost}}\n" }] },
      async (srcRoot) => {
        const result = await check({ srcRoot, sources });
        assert.deepEqual([...result.violations], []);
        assert.equal(result.warnings.length, 1);
        assert.equal(result.warnings[0]!.kind, "unresolved-external");
        assert.match(result.warnings[0]!.token, /agent:dev-tools:ghost/);
      },
    );
  });
});

test("check reports a malformed command ref when value does not match <plugin>:<command>", async () => {
  await withInstalledFixture([], async (sources) => {
    await withLocalSrcFixture(
      { skills: [{ plugin: "foo", skill: "bar", body: "{{command:lonely}}\n" }] },
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
    await withLocalSrcFixture(
      { skills: [{ plugin: "foo", skill: "bar", body: "{{agent:lonely}}\n" }] },
      async (srcRoot) => {
        const result = await check({ srcRoot, sources });
        assert.equal(result.violations.length, 1);
        assert.equal(result.violations[0]!.kind, "malformed");
      },
    );
  });
});

test("check resolves a {{skill:}} ref to a local plugin's skill", async () => {
  await withLocalSrcFixture(
    {
      skills: [
        { plugin: "foo", skill: "bar", body: "see {{skill:foo:bar}}\n" },
        { plugin: "foo", skill: "baz", body: "no refs\n" },
      ],
    },
    async (srcRoot) => {
      const result = await check({ srcRoot, sources: NO_INSTALLED });
      assert.deepEqual([...result.violations], []);
    },
  );
});

test("check fails on an unresolved internal {{skill:}} when the local plugin lacks the skill", async () => {
  await withLocalSrcFixture(
    { skills: [{ plugin: "foo", skill: "bar", body: "see {{skill:foo:missing}}\n" }] },
    async (srcRoot) => {
      const result = await check({ srcRoot, sources: NO_INSTALLED });
      assert.equal(result.violations.length, 1);
      assert.equal(result.violations[0]!.kind, "unresolved");
      assert.match(result.violations[0]!.message, /not found in this marketplace/i);
      assert.match(result.violations[0]!.token, /skill:foo:missing/);
    },
  );
});

test("check resolves a {{command:}} ref to a local plugin's command", async () => {
  await withLocalSrcFixture(
    {
      skills: [{ plugin: "foo", skill: "bar", body: "run {{command:foo:open-pr}}\n" }],
      commands: [{ plugin: "foo", command: "open-pr" }],
    },
    async (srcRoot) => {
      const result = await check({ srcRoot, sources: NO_INSTALLED });
      assert.deepEqual([...result.violations], []);
    },
  );
});

test("check fails on an unresolved internal {{command:}} when the local plugin lacks the command", async () => {
  await withLocalSrcFixture(
    {
      skills: [{ plugin: "foo", skill: "bar", body: "run {{command:foo:ghost}}\n" }],
      commands: [{ plugin: "foo", command: "open-pr" }],
    },
    async (srcRoot) => {
      const result = await check({ srcRoot, sources: NO_INSTALLED });
      assert.equal(result.violations.length, 1);
      assert.equal(result.violations[0]!.kind, "unresolved");
      assert.match(result.violations[0]!.token, /command:foo:ghost/);
    },
  );
});

test("check resolves a {{agent:}} ref to a local plugin's agent", async () => {
  await withLocalSrcFixture(
    {
      skills: [{ plugin: "foo", skill: "bar", body: "dispatch {{agent:foo:reviewer}}\n" }],
      agents: [{ plugin: "foo", agent: "reviewer" }],
    },
    async (srcRoot) => {
      const result = await check({ srcRoot, sources: NO_INSTALLED });
      assert.deepEqual([...result.violations], []);
    },
  );
});

test("check fails on an unresolved internal {{agent:}} when the local plugin lacks the agent", async () => {
  await withLocalSrcFixture(
    {
      skills: [{ plugin: "foo", skill: "bar", body: "dispatch {{agent:foo:ghost}}\n" }],
      agents: [{ plugin: "foo", agent: "reviewer" }],
    },
    async (srcRoot) => {
      const result = await check({ srcRoot, sources: NO_INSTALLED });
      assert.equal(result.violations.length, 1);
      assert.equal(result.violations[0]!.kind, "unresolved");
      assert.match(result.violations[0]!.token, /agent:foo:ghost/);
    },
  );
});

test("check scans command bodies for placeholder violations", async () => {
  await withLocalSrcFixture(
    { commands: [{ plugin: "foo", command: "do-thing", body: "see {{skill:foo:ghost}}\n" }] },
    async (srcRoot) => {
      const result = await check({ srcRoot, sources: NO_INSTALLED });
      assert.equal(result.violations.length, 1);
      assert.equal(result.violations[0]!.kind, "unresolved");
      assert.match(result.violations[0]!.token, /skill:foo:ghost/);
    },
  );
});

test("check scans agent bodies for placeholder violations", async () => {
  await withLocalSrcFixture(
    { agents: [{ plugin: "foo", agent: "reviewer", body: "see {{skill:foo:ghost}}\n" }] },
    async (srcRoot) => {
      const result = await check({ srcRoot, sources: NO_INSTALLED });
      assert.equal(result.violations.length, 1);
      assert.equal(result.violations[0]!.kind, "unresolved");
      assert.match(result.violations[0]!.token, /skill:foo:ghost/);
    },
  );
});

test("check reports a malformed {{skill:}} when value does not match <plugin>:<name>", async () => {
  await withLocalSrcFixture(
    { skills: [{ plugin: "foo", skill: "bar", body: "see {{skill:lonely}}\n" }] },
    async (srcRoot) => {
      const result = await check({ srcRoot, sources: NO_INSTALLED });
      assert.equal(result.violations.length, 1);
      assert.equal(result.violations[0]!.kind, "malformed");
    },
  );
});

test("check resolves refs against the union of local and installed", async () => {
  await withInstalledFixture([{ plugin: "superpowers", skill: "tdd" }], async (sources) => {
    await withLocalSrcFixture(
      {
        skills: [
          {
            plugin: "foo",
            skill: "bar",
            body: "{{skill:foo:bar}} and {{skill:superpowers:tdd}}\n",
          },
        ],
      },
      async (srcRoot) => {
        const result = await check({ srcRoot, sources });
        assert.deepEqual([...result.violations], []);
        assert.deepEqual([...result.warnings], []);
      },
    );
  });
});

test("check splits a mixed body: internal-missing fails, external-missing warns", async () => {
  await withInstalledFixture([{ plugin: "superpowers", skill: "tdd" }], async (sources) => {
    await withLocalSrcFixture(
      {
        skills: [
          { plugin: "foo", skill: "bar", body: "{{skill:nope:missing}} {{skill:foo:ghost}}\n" },
        ],
      },
      async (srcRoot) => {
        const result = await check({ srcRoot, sources });
        assert.equal(result.violations.length, 1);
        assert.equal(result.violations[0]!.kind, "unresolved");
        assert.match(result.violations[0]!.token, /skill:foo:ghost/);
        const external = result.warnings.filter((w) => w.kind === "unresolved-external");
        assert.equal(external.length, 1);
        assert.match(external[0]!.token, /skill:nope:missing/);
      },
    );
  });
});

test("check rejects when the source root has no marketplace manifest", async () => {
  const sandbox = mkdtempSync(join(repoRoot, ".test-tmp-check-nomarket-"));
  const srcRoot = join(sandbox, "src");
  mkdirSync(srcRoot, { recursive: true });
  try {
    await withInstalledFixture([], async (sources) => {
      await assert.rejects(
        check({ srcRoot, sources }),
        /failed to load layout: marketplace manifest not found at .+marketplace\.json/,
      );
    });
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("check warns about a slash reference to a known command written outside a placeholder", async () => {
  await withLocalSrcFixture(
    {
      skills: [{ plugin: "foo", skill: "bar", body: "run /foo:ship directly\n" }],
      commands: [{ plugin: "foo", command: "ship", body: "x\n" }],
    },
    async (srcRoot) => {
      const result = await check({ srcRoot, sources: NO_INSTALLED });
      assert.deepEqual([...result.violations], []);
      const bypass = result.warnings.filter((w) => w.kind === "bypass");
      assert.equal(bypass.length, 1);
      assert.equal(bypass[0]!.id, "foo:ship");
      assert.equal(bypass[0]!.prefix, "command");
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
      const result = await check({ srcRoot, sources: NO_INSTALLED });
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
      const result = await check({ srcRoot, sources: NO_INSTALLED });
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
      const result = await check({ srcRoot, sources: NO_INSTALLED });
      const bypass = result.warnings.filter((w) => w.kind === "bypass");
      assert.equal(bypass.length, 1);
      assert.equal(bypass[0]!.id, "foo:bar");
      assert.equal(bypass[0]!.prefix, "agent");
      assert.match(bypass[0]!.file, /details\.md$/);
    },
  );
});

test("check warns about a bareword reference inside a companion summary", async () => {
  await withLocalSrcFixture(
    {
      skills: [
        {
          plugin: "foo",
          skill: "bar",
          body: "x\n",
          companions: [{ file: "details.md", body: "y\n", summary: "Pairs with foo:helper." }],
        },
      ],
      agents: [{ plugin: "foo", agent: "helper", body: "z\n" }],
    },
    async (srcRoot) => {
      const result = await check({ srcRoot, sources: NO_INSTALLED });
      const bypass = result.warnings.filter((w) => w.kind === "bypass");
      assert.equal(bypass.length, 1);
      assert.equal(bypass[0]!.id, "foo:helper");
      assert.match(bypass[0]!.file, /SKILL\.md$/);
      assert.equal(bypass[0]!.line, 6);
    },
  );
});

test("check scans every companion summary, even when two share identical text", async () => {
  await withLocalSrcFixture(
    {
      skills: [
        {
          plugin: "foo",
          skill: "bar",
          body: "x\n",
          companions: [
            { file: "one.md", body: "a\n", summary: "Pairs with foo:helper." },
            { file: "two.md", body: "b\n", summary: "Pairs with foo:helper." },
          ],
        },
      ],
      agents: [{ plugin: "foo", agent: "helper", body: "z\n" }],
    },
    async (srcRoot) => {
      const result = await check({ srcRoot, sources: NO_INSTALLED });
      const bypass = result.warnings.filter((w) => w.kind === "bypass");
      assert.equal(bypass.length, 2);
      assert.deepEqual(bypass.map((b) => b.line).sort(), [6, 8]);
    },
  );
});

test("check flags a backticked sibling companion .md inside a companion summary", async () => {
  await withLocalSrcFixture(
    {
      skills: [
        {
          plugin: "foo",
          skill: "bar",
          body: "see {{ref:details.md}}\n",
          companions: [{ file: "details.md", body: "y\n", summary: "Deep dive in `details.md`." }],
        },
      ],
    },
    async (srcRoot) => {
      const result = await check({ srcRoot, sources: NO_INSTALLED });
      const refs = result.violations.filter((v) => v.kind === "ref-bareword");
      assert.equal(refs.length, 1);
      assert.equal(refs[0]!.token, "details.md");
      assert.match(refs[0]!.file, /SKILL\.md$/);
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
  mkdirSync(join(srcRoot, "plugins/foo/.claude-plugin"), { recursive: true });
  writeFileSync(
    join(srcRoot, "plugins/foo/.claude-plugin/plugin.json"),
    JSON.stringify({ name: "foo", version: "0.0.1", description: "x" }),
  );
  mkdirSync(join(srcRoot, ".claude-plugin"), { recursive: true });
  writeFileSync(
    join(srcRoot, ".claude-plugin/marketplace.json"),
    JSON.stringify({
      name: "check-missing-test",
      owner: { name: "harness-kit-tests" },
      plugins: [{ name: "foo", source: "./plugins/foo" }],
    }),
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

test("check flags a backticked bareword that names a known local skill", async () => {
  await withLocalSrcFixture(
    {
      skills: [
        { plugin: "foo", skill: "caller", body: "delegate to `worker` now\n" },
        { plugin: "foo", skill: "worker", body: "does work\n" },
      ],
    },
    async (srcRoot) => {
      const result = await check({ srcRoot, sources: NO_INSTALLED });
      const bareword = result.violations.filter((v) => v.kind === "bareword");
      assert.equal(bareword.length, 1);
      assert.equal(bareword[0]!.token, "worker");
      assert.match(bareword[0]!.message, /\{\{skill:foo:worker\}\}/);
    },
  );
});

test("check does not flag a skill backticking its own leaf name", async () => {
  await withLocalSrcFixture(
    { skills: [{ plugin: "foo", skill: "verify", body: "`verify` runs the suite\n" }] },
    async (srcRoot) => {
      const result = await check({ srcRoot, sources: NO_INSTALLED });
      assert.deepEqual(
        result.violations.filter((v) => v.kind === "bareword"),
        [],
      );
    },
  );
});

test("check flags a backticked leaf inside a command invoke body", async () => {
  await withLocalSrcFixture(
    {
      skills: [{ plugin: "foo", skill: "ship", body: "ships it\n" }],
      commands: [{ plugin: "foo", command: "go", body: "Invoke `ship` skill on `$1`.\n" }],
    },
    async (srcRoot) => {
      const result = await check({ srcRoot, sources: NO_INSTALLED });
      const bareword = result.violations.filter((v) => v.kind === "bareword");
      assert.equal(bareword.length, 1);
      assert.equal(bareword[0]!.token, "ship");
      assert.match(bareword[0]!.file, /go\.md$/);
    },
  );
});

test("check flags a backticked bareword in a plugin-root doc file (README, auto-invoke)", async () => {
  await withLocalSrcFixture(
    { skills: [{ plugin: "foo", skill: "worker", body: "does work\n" }] },
    async (srcRoot) => {
      writeFileSync(
        join(srcRoot, "plugins", "foo", "README.md"),
        "the `worker` skill does the work\n",
      );
      const result = await check({ srcRoot, sources: NO_INSTALLED });
      const bareword = result.violations.filter((v) => v.kind === "bareword");
      assert.equal(bareword.length, 1);
      assert.equal(bareword[0]!.token, "worker");
      assert.match(bareword[0]!.file, /README\.md$/);
    },
  );
});

test("check does not flag a backticked lang-skill leaf", async () => {
  await withLocalSrcFixture(
    {
      skills: [
        { plugin: "foo", skill: "rspec", body: "test guidance\n" },
        { plugin: "foo", skill: "caller", body: "run `rspec` to test\n" },
      ],
    },
    async (srcRoot) => {
      const result = await check({ srcRoot, sources: NO_INSTALLED });
      assert.deepEqual(
        result.violations.filter((v) => v.kind === "bareword"),
        [],
      );
    },
  );
});

test("check flags a backticked sibling companion .md as a ref bypass", async () => {
  await withLocalSrcFixture(
    {
      skills: [
        {
          plugin: "foo",
          skill: "bar",
          body: "full detail in `procedure.md`\n",
          companions: [{ file: "procedure.md", body: "steps\n" }],
        },
      ],
    },
    async (srcRoot) => {
      const result = await check({ srcRoot, sources: NO_INSTALLED });
      const refs = result.violations.filter((v) => v.kind === "ref-bareword");
      assert.equal(refs.length, 1);
      assert.equal(refs[0]!.token, "procedure.md");
      assert.match(refs[0]!.message, /\{\{ref:procedure\.md\}\}/);
    },
  );
});

test("check does not flag an already-templated companion ref or a generic .md mention", async () => {
  await withLocalSrcFixture(
    {
      skills: [
        {
          plugin: "foo",
          skill: "bar",
          body: "see {{ref:procedure.md}} and each skill's own `rationalizations.md`\n",
          companions: [{ file: "procedure.md", body: "steps\n" }],
        },
      ],
    },
    async (srcRoot) => {
      const result = await check({ srcRoot, sources: NO_INSTALLED });
      assert.deepEqual(
        result.violations.filter((v) => v.kind === "ref-bareword"),
        [],
      );
    },
  );
});
