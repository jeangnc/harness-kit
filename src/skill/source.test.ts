import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { findSkillFile, loadSkill } from "./source.js";

interface SandboxOptions {
  readonly skillMd?: string;
}

async function withSkillSandbox<T>(
  options: SandboxOptions,
  fn: (skillDir: string) => Promise<T>,
): Promise<T> {
  const sandbox = mkdtempSync(join(tmpdir(), "harness-kit-skill-source-"));
  const skillDir = join(sandbox, "plugins/foo/skills/bar");
  mkdirSync(skillDir, { recursive: true });
  if (options.skillMd !== undefined) writeFileSync(join(skillDir, "SKILL.md"), options.skillMd);
  return fn(skillDir).finally(() => rmSync(sandbox, { recursive: true, force: true }));
}

const SKILL_MD_BARE = `---
name: bar
description: fixture skill
---

# Bar
inline body
`;

test("findSkillFile returns null when SKILL.md is absent", async () => {
  await withSkillSandbox({}, async (skillDir) => {
    assert.equal(await findSkillFile(skillDir), null);
  });
});

test("findSkillFile returns the SKILL.md path when it exists", async () => {
  await withSkillSandbox({ skillMd: SKILL_MD_BARE }, async (skillDir) => {
    assert.equal(await findSkillFile(skillDir), join(skillDir, "SKILL.md"));
  });
});

test("loadSkill returns frontmatter, body, and a body offset past the frontmatter", async () => {
  await withSkillSandbox({ skillMd: SKILL_MD_BARE }, async (skillDir) => {
    const result = await loadSkill(skillDir);
    if (!result.ok) assert.fail(`expected ok, got error: ${JSON.stringify(result.error)}`);
    const loaded = result.value;
    assert.equal(loaded.skill.name, "bar");
    assert.equal(loaded.skill.description, "fixture skill");
    assert.equal(loaded.body, "# Bar\ninline body\n");
    assert.ok(loaded.bodyOffset > 0);
    assert.equal(loaded.skillFilePath, join(skillDir, "SKILL.md"));
    assert.equal(loaded.skillDir, skillDir);
  });
});

test("loadSkill, when a sibling body.md exists, ignores it as ordinary content", async () => {
  await withSkillSandbox({ skillMd: SKILL_MD_BARE }, async (skillDir) => {
    writeFileSync(join(skillDir, "body.md"), "# unrelated\n");
    const result = await loadSkill(skillDir);
    if (!result.ok) assert.fail(`expected ok, got error: ${JSON.stringify(result.error)}`);
    assert.equal(result.value.body, "# Bar\ninline body\n");
  });
});

test("loadSkill, when frontmatter violates SkillSchema, returns schema-violation error with issues", async () => {
  const badFrontmatter = `---
name: BAR
description: x
---

body
`;
  await withSkillSandbox({ skillMd: badFrontmatter }, async (skillDir) => {
    const result = await loadSkill(skillDir);
    if (result.ok) assert.fail("expected error, got ok");
    assert.equal(result.error.tag, "schema-violation");
    if (result.error.tag !== "schema-violation") return;
    assert.ok(result.error.issues.some((i) => i.includes("name")));
  });
});

test("loadSkill, when SKILL.md is absent, returns no-source error", async () => {
  await withSkillSandbox({}, async (skillDir) => {
    const result = await loadSkill(skillDir);
    if (result.ok) assert.fail("expected error, got ok");
    assert.equal(result.error.tag, "no-source");
  });
});
