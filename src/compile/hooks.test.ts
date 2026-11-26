import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { compilePlugins } from "./index.js";
import { claudeVendor } from "../vendors/claude/index.js";
import { layoutAt, type Layout } from "../layout/index.js";
import { AGENT_PLUGINS_SCHEMA } from "../plugin/index.js";

const vendors = [claudeVendor];

function testLayout(repoRoot: string, distRoot: string): Layout {
  return { ...layoutAt(repoRoot), buildDir: distRoot };
}

function seedPlugin(repoRoot: string, pluginName: string): void {
  writeFileSync(
    join(repoRoot, "harness.yaml"),
    "marketplace: test-marketplace\nowner:\n  name: harness-kit-tests\nvendors: [claude]\n",
  );
  const pluginDir = join(repoRoot, "plugins", pluginName);
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(
    join(pluginDir, "plugin.json"),
    JSON.stringify(
      {
        $schema: AGENT_PLUGINS_SCHEMA,
        name: pluginName,
        version: "0.0.1",
        description: "test fixture plugin",
      },
      null,
      2,
    ) + "\n",
  );
}

async function withHookFixture<T>(
  hookScript: string,
  fn: (repoRoot: string, distRoot: string) => Promise<T>,
): Promise<T> {
  const repoRoot = mkdtempSync(join(tmpdir(), "harness-kit-repo-"));
  const distRoot = mkdtempSync(join(tmpdir(), "harness-kit-dist-"));
  const hooksDir = join(repoRoot, "plugins/foo/hooks");
  mkdirSync(hooksDir, { recursive: true });
  writeFileSync(join(hooksDir, "context.sh"), hookScript);
  seedPlugin(repoRoot, "foo");
  return fn(repoRoot, distRoot).finally(() => {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(distRoot, { recursive: true, force: true });
  });
}

const ROOT_ASSIGN = `root="\${CLAUDE_PLUGIN_ROOT:?CLAUDE_PLUGIN_ROOT must be set}"`;

async function withLangSkillsFixture<T>(
  hookScript: string,
  langSkills: string,
  fn: (repoRoot: string, distRoot: string) => Promise<T>,
): Promise<T> {
  const repoRoot = mkdtempSync(join(tmpdir(), "harness-kit-repo-"));
  const distRoot = mkdtempSync(join(tmpdir(), "harness-kit-dist-"));
  const pluginDir = join(repoRoot, "plugins/foo");
  mkdirSync(join(pluginDir, "hooks"), { recursive: true });
  mkdirSync(join(pluginDir, "shared"), { recursive: true });
  writeFileSync(join(pluginDir, "hooks/require-skill.sh"), hookScript);
  writeFileSync(join(pluginDir, "shared/lang-skills.md"), langSkills);
  seedPlugin(repoRoot, "foo");
  return fn(repoRoot, distRoot).finally(() => {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(distRoot, { recursive: true, force: true });
  });
}

const LANG_SKILLS_TABLE = `| File pattern | Skills in force |
| --- | --- |
| \`*.rb\` | {{skill:foo:ruby}} |
| \`*.tsx\` | {{skill:foo:react}} |
`;

test("compile fails when a hook names a skill that shared/lang-skills.md does not resolve", async () => {
  const script = `#!/usr/bin/env bash
skills="foo:react-components"
`;
  await withLangSkillsFixture(script, LANG_SKILLS_TABLE, async (repoRoot, distRoot) => {
    await assert.rejects(
      compilePlugins({ layout: testLayout(repoRoot, distRoot), vendors }),
      /foo:react-components/,
    );
  });
});

test("compile accepts a hook whose skill names all appear in shared/lang-skills.md", async () => {
  const script = `#!/usr/bin/env bash
case "$rule_key" in
  ruby)  skills="foo:ruby" ;;
  react) skills="foo:react" ;;
esac
`;
  await withLangSkillsFixture(script, LANG_SKILLS_TABLE, async (repoRoot, distRoot) => {
    await compilePlugins({ layout: testLayout(repoRoot, distRoot), vendors });
    assert.ok(existsSync(join(distRoot, "claude/plugins/foo/.claude-plugin/plugin.json")));
  });
});

test("compile ignores a colon-shaped literal whose prefix is not a plugin in the marketplace", async () => {
  const script = `#!/usr/bin/env bash
url="https://example.com/x"
note="unrelated:token"
skills="foo:ruby"
`;
  await withLangSkillsFixture(script, LANG_SKILLS_TABLE, async (repoRoot, distRoot) => {
    await compilePlugins({ layout: testLayout(repoRoot, distRoot), vendors });
    assert.ok(existsSync(join(distRoot, "claude/plugins/foo/.claude-plugin/plugin.json")));
  });
});

test("compile skips the skill-mirror check for a plugin with no shared/lang-skills.md", async () => {
  const script = `#!/usr/bin/env bash
skills="foo:not-in-any-table"
`;
  await withHookFixture(script, async (repoRoot, distRoot) => {
    await compilePlugins({ layout: testLayout(repoRoot, distRoot), vendors });
    assert.ok(existsSync(join(distRoot, "claude/plugins/foo/.claude-plugin/plugin.json")));
  });
});

test("compile fails when a hook reads $root/.fragments/foo.md — a dot-segment path the compiler never emits to dist", async () => {
  const script = `#!/usr/bin/env bash
set -euo pipefail
${ROOT_ASSIGN}
table="$(<"$root/.fragments/foo.md")"
`;
  await withHookFixture(script, async (repoRoot, distRoot) => {
    await assert.rejects(
      compilePlugins({ layout: testLayout(repoRoot, distRoot), vendors }),
      /\.fragments\/foo\.md/,
    );
  });
});

test("compile accepts a hook reading $root/skill-triggers.md — a plugin-root file the compiler emits", async () => {
  const script = `#!/usr/bin/env bash
set -euo pipefail
${ROOT_ASSIGN}
table="$(<"$root/skill-triggers.md")"
`;
  await withHookFixture(script, async (repoRoot, distRoot) => {
    await compilePlugins({ layout: testLayout(repoRoot, distRoot), vendors });
    assert.ok(existsSync(join(distRoot, "claude/plugins/foo/.claude-plugin/plugin.json")));
  });
});

test("compile accepts a hook reading $root/shared/x.md — a nested non-dot path the compiler emits", async () => {
  const script = `#!/usr/bin/env bash
set -euo pipefail
${ROOT_ASSIGN}
cat "$root/shared/x.md"
`;
  await withHookFixture(script, async (repoRoot, distRoot) => {
    await compilePlugins({ layout: testLayout(repoRoot, distRoot), vendors });
    assert.ok(existsSync(join(distRoot, "claude/plugins/foo/.claude-plugin/plugin.json")));
  });
});

test("compile accepts a hook reading $root/.mcp.json — a passthrough dotfile the compiler emits", async () => {
  const script = `#!/usr/bin/env bash
set -euo pipefail
${ROOT_ASSIGN}
cat "$root/.mcp.json"
`;
  await withHookFixture(script, async (repoRoot, distRoot) => {
    await compilePlugins({ layout: testLayout(repoRoot, distRoot), vendors });
    assert.ok(existsSync(join(distRoot, "claude/plugins/foo/.claude-plugin/plugin.json")));
  });
});

test("compile skips a hook reading $root/$f — a variable path segment that cannot be statically resolved", async () => {
  const script = `#!/usr/bin/env bash
set -euo pipefail
${ROOT_ASSIGN}
for f in instructions.md conventions.md; do
  cat "$root/$f"
done
`;
  await withHookFixture(script, async (repoRoot, distRoot) => {
    await compilePlugins({ layout: testLayout(repoRoot, distRoot), vendors });
    assert.ok(existsSync(join(distRoot, "claude/plugins/foo/.claude-plugin/plugin.json")));
  });
});

test("compile fails when a hook reads ${root}/.fragments/foo.md — the brace form is detected like $root/", async () => {
  const script = `#!/usr/bin/env bash
set -euo pipefail
${ROOT_ASSIGN}
cat "\${root}/.fragments/foo.md"
`;
  await withHookFixture(script, async (repoRoot, distRoot) => {
    await assert.rejects(
      compilePlugins({ layout: testLayout(repoRoot, distRoot), vendors }),
      /\.fragments\/foo\.md/,
    );
  });
});
