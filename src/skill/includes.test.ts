import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { expandIncludes, formatIncludeError } from "./includes.js";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

type Files = Readonly<Record<string, string>>;

async function withSkill<T>(files: Files, fn: (skillDir: string) => Promise<T>): Promise<T> {
  const sandbox = mkdtempSync(join(repoRoot, ".test-tmp-includes-"));
  const skillDir = join(sandbox, "plugins/foo/skills/bar");
  mkdirSync(skillDir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const full = join(skillDir, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  return fn(skillDir).finally(() => rmSync(sandbox, { recursive: true, force: true }));
}

test("expandIncludes inlines a sibling .md file verbatim", async () => {
  await withSkill({ "fragment.md": "hello world\n" }, async (skillDir) => {
    const body = "before\n{{include:./fragment.md}}\nafter\n";
    const result = await expandIncludes(body, join(skillDir, "SKILL.md"), skillDir);
    if (!result.ok) assert.fail(`expected ok, got ${JSON.stringify(result.error)}`);
    assert.equal(result.value.body, "before\nhello world\nafter\n");
    assert.deepEqual([...result.value.resolvedIncludes], [join(skillDir, "fragment.md")]);
  });
});

test("expandIncludes strips the included file's single trailing newline", async () => {
  await withSkill({ "fragment.md": "hello world\n" }, async (skillDir) => {
    const body = "before\n\n{{include:./fragment.md}}\n\nafter\n";
    const result = await expandIncludes(body, join(skillDir, "SKILL.md"), skillDir);
    if (!result.ok) assert.fail(`expected ok, got ${JSON.stringify(result.error)}`);
    assert.equal(result.value.body, "before\n\nhello world\n\nafter\n");
  });
});

test("expandIncludes recurses through nested includes", async () => {
  await withSkill(
    {
      "a.md": "A:\n{{include:./b.md}}\n",
      "b.md": "B:\n{{include:./c.md}}\n",
      "c.md": "C\n",
    },
    async (skillDir) => {
      const body = "{{include:./a.md}}";
      const result = await expandIncludes(body, join(skillDir, "SKILL.md"), skillDir);
      if (!result.ok) assert.fail(`expected ok, got ${JSON.stringify(result.error)}`);
      assert.equal(result.value.body, "A:\nB:\nC");
      assert.equal(result.value.resolvedIncludes.size, 3);
    },
  );
});

test("expandIncludes detects a direct cycle", async () => {
  await withSkill({ "loop.md": "{{include:./loop.md}}" }, async (skillDir) => {
    const body = "{{include:./loop.md}}";
    const result = await expandIncludes(body, join(skillDir, "SKILL.md"), skillDir);
    if (result.ok) assert.fail("expected cycle error");
    assert.ok(result.error.some((e) => e.tag === "include-cycle"));
  });
});

test("expandIncludes detects an indirect cycle", async () => {
  await withSkill(
    { "a.md": "{{include:./b.md}}", "b.md": "{{include:./a.md}}" },
    async (skillDir) => {
      const body = "{{include:./a.md}}";
      const result = await expandIncludes(body, join(skillDir, "SKILL.md"), skillDir);
      if (result.ok) assert.fail("expected cycle error");
      assert.ok(result.error.some((e) => e.tag === "include-cycle"));
    },
  );
});

test("expandIncludes returns include-missing for a non-existent target", async () => {
  await withSkill({}, async (skillDir) => {
    const body = "{{include:./ghost.md}}";
    const result = await expandIncludes(body, join(skillDir, "SKILL.md"), skillDir);
    if (result.ok) assert.fail("expected missing error");
    assert.equal(result.error[0]?.tag, "include-missing");
  });
});

test("expandIncludes rejects an absolute path", async () => {
  await withSkill({}, async (skillDir) => {
    const body = "{{include:/etc/passwd}}";
    const result = await expandIncludes(body, join(skillDir, "SKILL.md"), skillDir);
    if (result.ok) assert.fail("expected absolute-path error");
    assert.equal(result.error[0]?.tag, "include-absolute");
  });
});

test("expandIncludes rejects a path that escapes the skill directory", async () => {
  await withSkill({}, async (skillDir) => {
    const body = "{{include:../sibling/leak.md}}";
    const result = await expandIncludes(body, join(skillDir, "SKILL.md"), skillDir);
    if (result.ok) assert.fail("expected escapes-skill error");
    assert.equal(result.error[0]?.tag, "include-escapes-skill");
  });
});

test("expandIncludes rejects a non-.md target", async () => {
  await withSkill({ "data.json": "{}" }, async (skillDir) => {
    const body = "{{include:./data.json}}";
    const result = await expandIncludes(body, join(skillDir, "SKILL.md"), skillDir);
    if (result.ok) assert.fail("expected non-md error");
    assert.equal(result.error[0]?.tag, "include-not-md");
  });
});

test("expandIncludes returns include-empty when the token has no value", async () => {
  await withSkill({}, async (skillDir) => {
    const body = "{{include}}";
    const result = await expandIncludes(body, join(skillDir, "SKILL.md"), skillDir);
    if (result.ok) assert.fail("expected empty error");
    assert.equal(result.error[0]?.tag, "include-empty");
  });
});

test("expandIncludes preserves non-include placeholders for the next pass", async () => {
  await withSkill(
    { "shared.md": "see {{skill:foo:bar}} and {{ref:./other.md}}\n" },
    async (skillDir) => {
      const body = "{{include:./shared.md}}";
      const result = await expandIncludes(body, join(skillDir, "SKILL.md"), skillDir);
      if (!result.ok) assert.fail(`expected ok, got ${JSON.stringify(result.error)}`);
      assert.ok(result.value.body.includes("{{skill:foo:bar}}"));
      assert.ok(result.value.body.includes("{{ref:./other.md}}"));
    },
  );
});

test("expandIncludes accepts whitespace inside the token value", async () => {
  await withSkill({ "fragment.md": "trim-me\n" }, async (skillDir) => {
    const body = "{{include: ./fragment.md }}";
    const result = await expandIncludes(body, join(skillDir, "SKILL.md"), skillDir);
    if (!result.ok) assert.fail(`expected ok, got ${JSON.stringify(result.error)}`);
    assert.equal(result.value.body, "trim-me");
  });
});

test("formatIncludeError produces a readable message for each variant", () => {
  assert.match(
    formatIncludeError({ tag: "include-cycle", chain: ["/a.md", "/b.md", "/a.md"] }),
    /cycle/,
  );
  assert.match(
    formatIncludeError({ tag: "include-missing", path: "./x.md", from: "/SKILL.md" }),
    /not found/,
  );
  assert.match(
    formatIncludeError({ tag: "include-escapes-skill", path: "../x.md", skillDir: "/skill" }),
    /escapes/,
  );
  assert.match(formatIncludeError({ tag: "include-not-md", path: "./x.json" }), /\.md/);
  assert.match(formatIncludeError({ tag: "include-absolute", raw: "{{include:/x}}" }), /relative/);
  assert.match(formatIncludeError({ tag: "include-empty", raw: "{{include}}" }), /relative-path/);
});
