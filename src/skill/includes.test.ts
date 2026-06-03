import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { expandIncludes, formatIncludeError, type IncludeRoots } from "./includes.js";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

type Files = Readonly<Record<string, string>>;

interface Sandbox {
  readonly skillDir: string;
  readonly roots: IncludeRoots;
  readonly write: (rel: string, content: string) => string;
}

async function withSkill<T>(
  files: Files,
  fn: (sandbox: Sandbox) => Promise<T>,
  named: Readonly<Record<string, string>> = {},
): Promise<T> {
  const sandbox = mkdtempSync(join(repoRoot, ".test-tmp-includes-"));
  const skillDir = join(sandbox, "plugins/foo/skills/bar");
  mkdirSync(skillDir, { recursive: true });
  const write = (rel: string, content: string): string => {
    const full = join(sandbox, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
    return full;
  };
  for (const [rel, content] of Object.entries(files)) {
    write(join("plugins/foo/skills/bar", rel), content);
  }
  const namedAbs = Object.fromEntries(
    Object.entries(named).map(([name, rel]) => [name, join(sandbox, rel)]),
  );
  const roots: IncludeRoots = { self: skillDir, named: namedAbs };
  return fn({ skillDir, roots, write }).finally(() =>
    rmSync(sandbox, { recursive: true, force: true }),
  );
}

function skillFile(skillDir: string): string {
  return join(skillDir, "SKILL.md");
}

test("expandIncludes inlines a sibling .md file verbatim", async () => {
  await withSkill({ "fragment.md": "hello world\n" }, async ({ skillDir, roots }) => {
    const body = "before\n{{include:./fragment.md}}\nafter\n";
    const result = await expandIncludes(body, skillFile(skillDir), roots);
    if (!result.ok) assert.fail(`expected ok, got ${JSON.stringify(result.error)}`);
    assert.equal(result.value.body, "before\nhello world\nafter\n");
    assert.deepEqual([...result.value.resolvedIncludes], [join(skillDir, "fragment.md")]);
  });
});

test("expandIncludes strips the included file's single trailing newline", async () => {
  await withSkill({ "fragment.md": "hello world\n" }, async ({ skillDir, roots }) => {
    const body = "before\n\n{{include:./fragment.md}}\n\nafter\n";
    const result = await expandIncludes(body, skillFile(skillDir), roots);
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
    async ({ skillDir, roots }) => {
      const body = "{{include:./a.md}}";
      const result = await expandIncludes(body, skillFile(skillDir), roots);
      if (!result.ok) assert.fail(`expected ok, got ${JSON.stringify(result.error)}`);
      assert.equal(result.value.body, "A:\nB:\nC");
      assert.equal(result.value.resolvedIncludes.size, 3);
    },
  );
});

test("expandIncludes detects a direct cycle", async () => {
  await withSkill({ "loop.md": "{{include:./loop.md}}" }, async ({ skillDir, roots }) => {
    const body = "{{include:./loop.md}}";
    const result = await expandIncludes(body, skillFile(skillDir), roots);
    if (result.ok) assert.fail("expected cycle error");
    assert.ok(result.error.some((e) => e.tag === "include-cycle"));
  });
});

test("expandIncludes detects an indirect cycle", async () => {
  await withSkill(
    { "a.md": "{{include:./b.md}}", "b.md": "{{include:./a.md}}" },
    async ({ skillDir, roots }) => {
      const body = "{{include:./a.md}}";
      const result = await expandIncludes(body, skillFile(skillDir), roots);
      if (result.ok) assert.fail("expected cycle error");
      assert.ok(result.error.some((e) => e.tag === "include-cycle"));
    },
  );
});

test("expandIncludes returns include-missing for a non-existent target", async () => {
  await withSkill({}, async ({ skillDir, roots }) => {
    const body = "{{include:./ghost.md}}";
    const result = await expandIncludes(body, skillFile(skillDir), roots);
    if (result.ok) assert.fail("expected missing error");
    assert.equal(result.error[0]?.tag, "include-missing");
  });
});

test("expandIncludes rejects an absolute path", async () => {
  await withSkill({}, async ({ skillDir, roots }) => {
    const body = "{{include:/etc/passwd}}";
    const result = await expandIncludes(body, skillFile(skillDir), roots);
    if (result.ok) assert.fail("expected absolute-path error");
    assert.equal(result.error[0]?.tag, "include-absolute");
  });
});

test("expandIncludes rejects a path that escapes all allowed roots", async () => {
  await withSkill({}, async ({ skillDir, roots }) => {
    const body = "{{include:../sibling/leak.md}}";
    const result = await expandIncludes(body, skillFile(skillDir), roots);
    if (result.ok) assert.fail("expected escapes-roots error");
    assert.equal(result.error[0]?.tag, "include-escapes-roots");
  });
});

test("expandIncludes rejects a non-.md target", async () => {
  await withSkill({ "data.json": "{}" }, async ({ skillDir, roots }) => {
    const body = "{{include:./data.json}}";
    const result = await expandIncludes(body, skillFile(skillDir), roots);
    if (result.ok) assert.fail("expected non-md error");
    assert.equal(result.error[0]?.tag, "include-not-md");
  });
});

test("expandIncludes returns include-empty when the token has no value", async () => {
  await withSkill({}, async ({ skillDir, roots }) => {
    const body = "{{include}}";
    const result = await expandIncludes(body, skillFile(skillDir), roots);
    if (result.ok) assert.fail("expected empty error");
    assert.equal(result.error[0]?.tag, "include-empty");
  });
});

test("expandIncludes preserves non-include placeholders for the next pass", async () => {
  await withSkill(
    { "shared.md": "see {{skill:foo:bar}} and {{ref:./other.md}}\n" },
    async ({ skillDir, roots }) => {
      const body = "{{include:./shared.md}}";
      const result = await expandIncludes(body, skillFile(skillDir), roots);
      if (!result.ok) assert.fail(`expected ok, got ${JSON.stringify(result.error)}`);
      assert.ok(result.value.body.includes("{{skill:foo:bar}}"));
      assert.ok(result.value.body.includes("{{ref:./other.md}}"));
    },
  );
});

test("expandIncludes accepts whitespace inside the token value", async () => {
  await withSkill({ "fragment.md": "trim-me\n" }, async ({ skillDir, roots }) => {
    const body = "{{include: ./fragment.md }}";
    const result = await expandIncludes(body, skillFile(skillDir), roots);
    if (!result.ok) assert.fail(`expected ok, got ${JSON.stringify(result.error)}`);
    assert.equal(result.value.body, "trim-me");
  });
});

test("expandIncludes resolves an @root-anchored include from a named root", async () => {
  await withSkill(
    {},
    async ({ skillDir, roots, write }) => {
      const sharedPath = write("shared/frag.md", "shared body\n");
      const body = "x\n{{include:@shared/frag.md}}\ny\n";
      const result = await expandIncludes(body, skillFile(skillDir), roots);
      if (!result.ok) assert.fail(`expected ok, got ${JSON.stringify(result.error)}`);
      assert.equal(result.value.body, "x\nshared body\ny\n");
      assert.deepEqual([...result.value.resolvedIncludes], [sharedPath]);
    },
    { shared: "shared" },
  );
});

test("expandIncludes resolves @root includes nested in subdirectories", async () => {
  await withSkill(
    {},
    async ({ skillDir, roots, write }) => {
      write("shared/deep/frag.md", "deep\n");
      const body = "{{include:@shared/deep/frag.md}}";
      const result = await expandIncludes(body, skillFile(skillDir), roots);
      if (!result.ok) assert.fail(`expected ok, got ${JSON.stringify(result.error)}`);
      assert.equal(result.value.body, "deep");
    },
    { shared: "shared" },
  );
});

test("expandIncludes reports include-unknown-root for an undeclared root name", async () => {
  await withSkill({}, async ({ skillDir, roots }) => {
    const body = "{{include:@nope/frag.md}}";
    const result = await expandIncludes(body, skillFile(skillDir), roots);
    if (result.ok) assert.fail("expected unknown-root error");
    assert.equal(result.error[0]?.tag, "include-unknown-root");
  });
});

test("expandIncludes reports include-anchor-without-path for a bare @root with no path", async () => {
  await withSkill(
    {},
    async ({ skillDir, roots }) => {
      const body = "{{include:@shared}}";
      const result = await expandIncludes(body, skillFile(skillDir), roots);
      if (result.ok) assert.fail("expected anchor-without-path error");
      assert.equal(result.error[0]?.tag, "include-anchor-without-path");
    },
    { shared: "shared" },
  );
});

test("expandIncludes accepts an @root include whose target lands inside a different declared root", async () => {
  await withSkill(
    {},
    async ({ skillDir, roots, write }) => {
      write("a/other/frag.md", "from other\n");
      const body = "{{include:@rootA/../other/frag.md}}";
      const result = await expandIncludes(body, skillFile(skillDir), roots);
      if (!result.ok) assert.fail(`expected ok, got ${JSON.stringify(result.error)}`);
      assert.equal(result.value.body, "from other");
    },
    { rootA: "a/sub", rootB: "a/other" },
  );
});

test("expandIncludes rejects an @root include that escapes its root via ..", async () => {
  await withSkill(
    {},
    async ({ skillDir, roots, write }) => {
      write("secret.md", "secret\n");
      const body = "{{include:@shared/../secret.md}}";
      const result = await expandIncludes(body, skillFile(skillDir), roots);
      if (result.ok) assert.fail("expected escapes-roots error");
      assert.equal(result.error[0]?.tag, "include-escapes-roots");
    },
    { shared: "shared" },
  );
});

test("expandIncludes still enforces .md for @root includes", async () => {
  await withSkill(
    {},
    async ({ skillDir, roots, write }) => {
      write("shared/data.json", "{}");
      const body = "{{include:@shared/data.json}}";
      const result = await expandIncludes(body, skillFile(skillDir), roots);
      if (result.ok) assert.fail("expected non-md error");
      assert.equal(result.error[0]?.tag, "include-not-md");
    },
    { shared: "shared" },
  );
});

test("expandIncludes detects a cycle spanning relative and @root forms", async () => {
  await withSkill(
    {},
    async ({ skillDir, roots, write }) => {
      write("shared/a.md", "{{include:./b.md}}");
      write("shared/b.md", "{{include:@shared/a.md}}");
      const body = "{{include:@shared/a.md}}";
      const result = await expandIncludes(body, skillFile(skillDir), roots);
      if (result.ok) assert.fail("expected cycle error");
      assert.ok(result.error.some((e) => e.tag === "include-cycle"));
    },
    { shared: "shared" },
  );
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
    formatIncludeError({ tag: "include-escapes-roots", path: "../x.md", roots: ["/skill"] }),
    /escapes/,
  );
  assert.match(
    formatIncludeError({
      tag: "include-unknown-root",
      raw: "{{include:@nope/x.md}}",
      name: "nope",
    }),
    /root/,
  );
  assert.match(
    formatIncludeError({
      tag: "include-anchor-without-path",
      raw: "{{include:@shared}}",
      name: "shared",
    }),
    /missing a path/,
  );
  assert.match(formatIncludeError({ tag: "include-not-md", path: "./x.json" }), /\.md/);
  assert.match(formatIncludeError({ tag: "include-absolute", raw: "{{include:/x}}" }), /relative/);
  assert.match(formatIncludeError({ tag: "include-empty", raw: "{{include}}" }), /relative-path/);
});
