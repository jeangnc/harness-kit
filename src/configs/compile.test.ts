import { test } from "node:test";
import { equal, match, rejects } from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { layoutAt, loadCatalogOrThrow, type Layout } from "../layout/index.js";
import { AGENT_PLUGINS_SCHEMA } from "../plugin/index.js";
import { compileConfigs } from "./compile.js";
import { makeFakeVendor as fakeVendor } from "../vendor/fakeVendor.testutil.js";

const claude = fakeVendor("claude");

interface Sandbox {
  readonly repoRoot: string;
  readonly layout: Layout;
  readonly outRoot: string;
}

async function withSandbox(fn: (s: Sandbox) => Promise<void> | void): Promise<void> {
  const repoRoot = mkdtempSync(join(tmpdir(), "harness-configs-compile-"));
  const layout = layoutAt(repoRoot);
  try {
    await fn({ repoRoot, layout, outRoot: layout.buildDir });
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
}

test("compileConfigs expands {{include:...}} in .md files under configs", async () => {
  await withSandbox(async ({ repoRoot, layout, outRoot }) => {
    mkdirSync(join(repoRoot, "configs"), { recursive: true });
    writeFileSync(join(repoRoot, "configs/AGENTS.md"), "# Top\n\n{{include:./fragment.md}}\n");
    writeFileSync(join(repoRoot, "configs/fragment.md"), "## Fragment\n\nbody\n");
    await compileConfigs({ layout, vendors: [claude] });
    const out = readFileSync(join(outRoot, "claude/configs/AGENTS.md"), "utf8");
    equal(out, "# Top\n\n## Fragment\n\nbody\n");
  });
});

test("compileConfigs copies non-.md files verbatim", async () => {
  await withSandbox(async ({ repoRoot, layout, outRoot }) => {
    mkdirSync(join(repoRoot, "configs"), { recursive: true });
    const original = '{"theme": "dark", "token": "{{include:./oops.md}}"}\n';
    writeFileSync(join(repoRoot, "configs/settings.json"), original);
    await compileConfigs({ layout, vendors: [claude] });
    const out = readFileSync(join(outRoot, "claude/configs/settings.json"), "utf8");
    equal(out, original);
  });
});

test("compileConfigs recurses into subdirectories under configs", async () => {
  await withSandbox(async ({ repoRoot, layout, outRoot }) => {
    mkdirSync(join(repoRoot, "configs/agents"), { recursive: true });
    writeFileSync(join(repoRoot, "configs/AGENTS.md"), "# Top\n\n{{include:./agents/foo.md}}\n");
    writeFileSync(join(repoRoot, "configs/agents/foo.md"), "## Foo\n");
    await compileConfigs({ layout, vendors: [claude] });
    equal(readFileSync(join(outRoot, "claude/configs/AGENTS.md"), "utf8"), "# Top\n\n## Foo\n");
    equal(readFileSync(join(outRoot, "claude/configs/agents/foo.md"), "utf8"), "## Foo\n");
  });
});

test("compileConfigs errors when a .md file uses an unknown placeholder prefix", async () => {
  await withSandbox(async ({ repoRoot, layout }) => {
    mkdirSync(join(repoRoot, "configs"), { recursive: true });
    writeFileSync(join(repoRoot, "configs/AGENTS.md"), "# Top\n\n{{bogus:value}}\n");
    await rejects(async () => compileConfigs({ layout, vendors: [claude] }), /bogus/);
  });
});

test("compileConfigs inlines {{include:...}} paths that escape the configs dir", async () => {
  await withSandbox(async ({ repoRoot, layout, outRoot }) => {
    mkdirSync(join(repoRoot, "configs"), { recursive: true });
    writeFileSync(join(repoRoot, "outside.md"), "outside body\n");
    writeFileSync(join(repoRoot, "configs/AGENTS.md"), "{{include:../outside.md}}\n");
    await compileConfigs({ layout, vendors: [claude] });
    const out = readFileSync(join(outRoot, "claude/configs/AGENTS.md"), "utf8");
    equal(out, "outside body\n");
  });
});

test("compileConfigs resolves {{include:@shared/...}} from a declared named root", async () => {
  await withSandbox(async ({ repoRoot, layout, outRoot }) => {
    mkdirSync(join(repoRoot, "configs"), { recursive: true });
    mkdirSync(join(repoRoot, "configs/codex"), { recursive: true });
    mkdirSync(join(repoRoot, "shared"), { recursive: true });
    writeFileSync(join(repoRoot, "shared/common.md"), "## Common\n\nshared body\n");
    writeFileSync(
      join(repoRoot, "configs/AGENTS.md"),
      "# Claude\n\n{{include:@shared/common.md}}\n",
    );
    writeFileSync(
      join(repoRoot, "configs/codex/AGENTS.md"),
      "# Codex\n\n{{include:@shared/common.md}}\n",
    );
    const codex = fakeVendor("codex");
    await compileConfigs({
      layout,
      vendors: [claude, codex],
      namedRoots: { shared: join(repoRoot, "shared") },
    });
    equal(
      readFileSync(join(outRoot, "claude/configs/AGENTS.md"), "utf8"),
      "# Claude\n\n## Common\n\nshared body\n",
    );
    equal(
      readFileSync(join(outRoot, "codex/configs/AGENTS.md"), "utf8"),
      "# Codex\n\n## Common\n\nshared body\n",
    );
  });
});

test("compileConfigs errors on {{include:@shared/...}} when no root is declared", async () => {
  await withSandbox(async ({ repoRoot, layout }) => {
    mkdirSync(join(repoRoot, "configs"), { recursive: true });
    writeFileSync(join(repoRoot, "configs/AGENTS.md"), "{{include:@shared/x.md}}\n");
    await rejects(async () => compileConfigs({ layout, vendors: [claude] }), /unknown root/);
  });
});

test("compileConfigs resolves {{include:#...}} from the repo root", async () => {
  await withSandbox(async ({ repoRoot, layout, outRoot }) => {
    mkdirSync(join(repoRoot, "configs"), { recursive: true });
    mkdirSync(join(repoRoot, "shared"), { recursive: true });
    writeFileSync(join(repoRoot, "shared/common.md"), "## Common\n\nshared body\n");
    writeFileSync(
      join(repoRoot, "configs/AGENTS.md"),
      "# Claude\n\n{{include:#shared/common.md}}\n",
    );
    await compileConfigs({ layout, vendors: [claude] });
    equal(
      readFileSync(join(outRoot, "claude/configs/AGENTS.md"), "utf8"),
      "# Claude\n\n## Common\n\nshared body\n",
    );
  });
});

test("compileConfigs emits neutral configs for every vendor", async () => {
  await withSandbox(async ({ repoRoot, layout, outRoot }) => {
    mkdirSync(join(repoRoot, "configs"), { recursive: true });
    writeFileSync(join(repoRoot, "configs/AGENTS.md"), "shared\n");
    const codex = fakeVendor("codex");
    await compileConfigs({ layout, vendors: [claude, codex] });
    equal(readFileSync(join(outRoot, "claude/configs/AGENTS.md"), "utf8"), "shared\n");
    equal(readFileSync(join(outRoot, "codex/configs/AGENTS.md"), "utf8"), "shared\n");
  });
});

test("compileConfigs emits a vendor overlay file only for that vendor", async () => {
  await withSandbox(async ({ repoRoot, layout, outRoot }) => {
    mkdirSync(join(repoRoot, "configs/codex"), { recursive: true });
    writeFileSync(join(repoRoot, "configs/codex/config.toml"), "model = 'x'\n");
    const codex = fakeVendor("codex");
    await compileConfigs({ layout, vendors: [claude, codex] });
    equal(existsSync(join(outRoot, "codex/configs/config.toml")), true);
    equal(existsSync(join(outRoot, "claude/configs/config.toml")), false);
  });
});

test("compileConfigs replaces a neutral file with the vendor overlay at the same path", async () => {
  await withSandbox(async ({ repoRoot, layout, outRoot }) => {
    mkdirSync(join(repoRoot, "configs/claude"), { recursive: true });
    writeFileSync(join(repoRoot, "configs/AGENTS.md"), "neutral\n");
    writeFileSync(join(repoRoot, "configs/claude/AGENTS.md"), "claude\n");
    const codex = fakeVendor("codex");
    await compileConfigs({ layout, vendors: [claude, codex] });
    equal(readFileSync(join(outRoot, "claude/configs/AGENTS.md"), "utf8"), "claude\n");
    equal(readFileSync(join(outRoot, "codex/configs/AGENTS.md"), "utf8"), "neutral\n");
  });
});

test("compileConfigs resolves a relative include through the vendor overlay", async () => {
  await withSandbox(async ({ repoRoot, layout, outRoot }) => {
    mkdirSync(join(repoRoot, "configs/.fragments"), { recursive: true });
    mkdirSync(join(repoRoot, "configs/claude/.fragments"), { recursive: true });
    writeFileSync(join(repoRoot, "configs/AGENTS.md"), "{{include:./.fragments/models.md}}\n");
    writeFileSync(join(repoRoot, "configs/.fragments/models.md"), "neutral models\n");
    writeFileSync(join(repoRoot, "configs/claude/.fragments/models.md"), "claude models\n");
    const codex = fakeVendor("codex");
    await compileConfigs({ layout, vendors: [claude, codex] });
    equal(readFileSync(join(outRoot, "claude/configs/AGENTS.md"), "utf8"), "claude models\n");
    equal(readFileSync(join(outRoot, "codex/configs/AGENTS.md"), "utf8"), "neutral models\n");
  });
});

test("compileConfigs resolves a named-root include through that root's vendor overlay", async () => {
  await withSandbox(async ({ repoRoot, layout, outRoot }) => {
    mkdirSync(join(repoRoot, "configs"), { recursive: true });
    mkdirSync(join(repoRoot, "shared/claude"), { recursive: true });
    writeFileSync(join(repoRoot, "configs/AGENTS.md"), "{{include:@shared/x.md}}\n");
    writeFileSync(join(repoRoot, "shared/x.md"), "neutral\n");
    writeFileSync(join(repoRoot, "shared/claude/x.md"), "claude\n");
    const codex = fakeVendor("codex");
    await compileConfigs({
      layout,
      vendors: [claude, codex],
      namedRoots: { shared: join(repoRoot, "shared") },
    });
    equal(readFileSync(join(outRoot, "claude/configs/AGENTS.md"), "utf8"), "claude\n");
    equal(readFileSync(join(outRoot, "codex/configs/AGENTS.md"), "utf8"), "neutral\n");
  });
});

test("compileConfigs fails when an overlay file is identical to the neutral file", async () => {
  await withSandbox(async ({ repoRoot, layout }) => {
    mkdirSync(join(repoRoot, "configs/claude"), { recursive: true });
    writeFileSync(join(repoRoot, "configs/AGENTS.md"), "same\n");
    writeFileSync(join(repoRoot, "configs/claude/AGENTS.md"), "same\n");
    await rejects(async () => compileConfigs({ layout, vendors: [claude] }), /identical/);
  });
});

function seedPluginSkill(repoRoot: string, skillRel: string): void {
  writeFileSync(
    join(repoRoot, "harness.yaml"),
    "marketplace: test-marketplace\nowner:\n  name: test\nvendors: { claude: { ref: harness/claude }, codex: { ref: harness/codex } }\n",
  );
  mkdirSync(join(repoRoot, "plugins/foo", dirname(skillRel)), { recursive: true });
  writeFileSync(
    join(repoRoot, "plugins/foo/plugin.json"),
    JSON.stringify({
      $schema: AGENT_PLUGINS_SCHEMA,
      name: "foo",
      version: "1.0.0",
      description: "t",
    }),
  );
  writeFileSync(
    join(repoRoot, "plugins/foo", skillRel),
    "---\nname: bar\ndescription: test skill\n---\n\nbody\n",
  );
}

test("compileConfigs resolves {{skill:plugin:name}} against the catalog's skills", async () => {
  await withSandbox(async ({ repoRoot, layout, outRoot }) => {
    seedPluginSkill(repoRoot, "skills/bar/SKILL.md");
    mkdirSync(join(repoRoot, "configs"), { recursive: true });
    writeFileSync(join(repoRoot, "configs/AGENTS.md"), "use {{skill:foo:bar}}\n");
    await compileConfigs({
      layout,
      vendors: [claude],
      catalog: await loadCatalogOrThrow(layout),
      installedIndex: { skills: new Map(), commands: new Map(), agents: new Map() },
    });
    const out = readFileSync(join(outRoot, "claude/configs/AGENTS.md"), "utf8");
    equal(out, "use `foo:bar`\n");
  });
});

test("compileConfigs warns on a skill that exists only in another vendor's overlay", async () => {
  await withSandbox(async ({ repoRoot, layout }) => {
    seedPluginSkill(repoRoot, "codex/skills/bar/SKILL.md");
    mkdirSync(join(repoRoot, "configs"), { recursive: true });
    writeFileSync(join(repoRoot, "configs/AGENTS.md"), "use {{skill:foo:bar}}\n");
    const warnings: string[] = [];
    await compileConfigs({
      layout,
      vendors: [claude],
      catalog: await loadCatalogOrThrow(layout),
      installedIndex: { skills: new Map(), commands: new Map(), agents: new Map() },
      onWarnings: (_, found) => warnings.push(...found),
    });
    match(warnings.join("\n"), /skill id "foo:bar" — not a local skill/);
  });
});

test("compileConfigs ignores dotfiles and .fragments/", async () => {
  await withSandbox(async ({ repoRoot, layout, outRoot }) => {
    mkdirSync(join(repoRoot, "configs/.fragments"), { recursive: true });
    writeFileSync(join(repoRoot, "configs/.fragments/x.md"), "");
    writeFileSync(join(repoRoot, "configs/.gitkeep"), "");
    writeFileSync(join(repoRoot, "configs/AGENTS.md"), "x\n");
    await compileConfigs({ layout, vendors: [claude] });
    equal(existsSync(join(outRoot, "claude/configs/.gitkeep")), false);
    equal(existsSync(join(outRoot, "claude/configs/.fragments")), false);
    equal(existsSync(join(outRoot, "claude/configs/AGENTS.md")), true);
  });
});

test("compileConfigs is a no-op when the repo has no configs dir", async () => {
  await withSandbox(async ({ layout, outRoot }) => {
    await compileConfigs({ layout, vendors: [claude] });
    equal(existsSync(join(outRoot, "claude/configs")), false);
  });
});
