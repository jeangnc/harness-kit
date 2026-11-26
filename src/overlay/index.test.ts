import { test } from "node:test";
import { deepEqual, equal, fail, match } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  effectiveTree,
  formatOverlayError,
  resolveIn,
  type EffectiveTree,
  type OverlayError,
} from "./index.js";

type Files = Readonly<Record<string, string>>;

const registeredVendors = ["claude", "codex"] as const;

async function withRoot<T>(files: Files, fn: (root: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "harness-kit-overlay-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  return fn(root).finally(() => rmSync(root, { recursive: true, force: true }));
}

async function treeFor(root: string, vendor: string): Promise<EffectiveTree> {
  const result = await effectiveTree({ root, vendor, registeredVendors });
  if (!result.ok) fail(`expected ok, got ${JSON.stringify(result.error)}`);
  return result.value;
}

async function errorsFor(root: string, vendor: string): Promise<readonly OverlayError[]> {
  const result = await effectiveTree({ root, vendor, registeredVendors });
  if (result.ok) fail(`expected errors, got ${JSON.stringify([...result.value.files])}`);
  return result.error;
}

test("effectiveTree of a neutral-only root lists every file sorted by relative path", async () => {
  await withRoot({ "b.md": "b", "a/z.md": "z", "a/b/c.md": "c" }, async (root) => {
    const tree = await treeFor(root, "claude");
    deepEqual(
      [...tree.files],
      [
        ["a/b/c.md", join(root, "a/b/c.md")],
        ["a/z.md", join(root, "a/z.md")],
        ["b.md", join(root, "b.md")],
      ],
    );
  });
});

test("effectiveTree adds an overlay file that has no neutral counterpart", async () => {
  await withRoot({ "a.md": "a", "claude/extra.md": "extra" }, async (root) => {
    const tree = await treeFor(root, "claude");
    equal(resolveIn(tree, "extra.md"), join(root, "claude/extra.md"));
    equal(resolveIn(tree, "a.md"), join(root, "a.md"));
  });
});

test("effectiveTree resolves a shared path to the vendor overlay file", async () => {
  await withRoot(
    { "skills/x/SKILL.md": "neutral", "claude/skills/x/SKILL.md": "claude" },
    async (root) => {
      const tree = await treeFor(root, "claude");
      equal(resolveIn(tree, "skills/x/SKILL.md"), join(root, "claude/skills/x/SKILL.md"));
      equal(tree.files.size, 1);
    },
  );
});

test("effectiveTree excludes another vendor's overlay", async () => {
  await withRoot({ "a.md": "a", "codex/a.md": "codex", "codex/only.md": "only" }, async (root) => {
    const tree = await treeFor(root, "claude");
    deepEqual([...tree.files], [["a.md", join(root, "a.md")]]);
  });
});

test("effectiveTree reports an overlay identical to the neutral file it shadows", async () => {
  await withRoot({ "a.md": "same", "claude/a.md": "same" }, async (root) => {
    const errors = await errorsFor(root, "claude");
    deepEqual(errors, [
      {
        kind: "redundant-overlay",
        relPath: "a.md",
        overlayPath: join(root, "claude/a.md"),
        neutralPath: join(root, "a.md"),
      },
    ]);
  });
});

test("effectiveTree ignores redundancy in an overlay of a vendor not requested", async () => {
  await withRoot({ "a.md": "same", "codex/a.md": "same" }, async (root) => {
    const tree = await treeFor(root, "claude");
    equal(resolveIn(tree, "a.md"), join(root, "a.md"));
  });
});

test("effectiveTree reports a vendor-named directory nested below the root", async () => {
  await withRoot({ "skills/claude/a.md": "a", "skills/x/codex/b.md": "b" }, async (root) => {
    const errors = await errorsFor(root, "claude");
    deepEqual(errors, [
      { kind: "misplaced-vendor-dir", path: join(root, "skills/claude"), vendor: "claude" },
      { kind: "misplaced-vendor-dir", path: join(root, "skills/x/codex"), vendor: "codex" },
    ]);
  });
});

test("effectiveTree reports a vendor directory nested inside an overlay", async () => {
  await withRoot({ "claude/codex/a.md": "a" }, async (root) => {
    const errors = await errorsFor(root, "claude");
    deepEqual(errors, [
      { kind: "misplaced-vendor-dir", path: join(root, "claude/codex"), vendor: "codex" },
    ]);
  });
});

test("effectiveTree collects misplaced and redundant errors together", async () => {
  await withRoot({ "a.md": "same", "claude/a.md": "same", "x/codex/b.md": "b" }, async (root) => {
    const errors = await errorsFor(root, "claude");
    deepEqual(
      errors.map((error) => error.kind),
      ["misplaced-vendor-dir", "redundant-overlay"],
    );
  });
});

test("effectiveTree of a missing root is an empty tree", async () => {
  const tree = await treeFor(join(tmpdir(), "harness-kit-overlay-missing", "nowhere"), "claude");
  equal(tree.files.size, 0);
});

test("effectiveTree includes dotfiles and dot-directories", async () => {
  await withRoot(
    { ".mcp.json": "{}", ".fragments/a.md": "a", "claude/.env": "x" },
    async (root) => {
      const tree = await treeFor(root, "claude");
      deepEqual([...tree.files.keys()], [".env", ".fragments/a.md", ".mcp.json"]);
    },
  );
});

test("effectiveTree lists a symlinked directory as a file without descending into it", async () => {
  await withRoot({ "real/a.md": "a" }, async (root) => {
    symlinkSync(join(root, "real"), join(root, "link"));
    const tree = await treeFor(root, "claude");
    deepEqual([...tree.files.keys()], ["link", "real/a.md"]);
  });
});

test("effectiveTree treats a top-level file named after a vendor as neutral", async () => {
  await withRoot({ claude: "not a directory" }, async (root) => {
    const tree = await treeFor(root, "codex");
    equal(resolveIn(tree, "claude"), join(root, "claude"));
  });
});

test("formatOverlayError names the misplaced directory and where overlays belong", () => {
  const message = formatOverlayError({
    kind: "misplaced-vendor-dir",
    path: "/r/skills/claude",
    vendor: "claude",
  });
  match(message, /\/r\/skills\/claude/);
  match(message, /directly under the root/);
});

test("formatOverlayError names both paths of a redundant overlay", () => {
  const message = formatOverlayError({
    kind: "redundant-overlay",
    relPath: "a.md",
    overlayPath: "/r/claude/a.md",
    neutralPath: "/r/a.md",
  });
  match(message, /\/r\/claude\/a\.md/);
  match(message, /\/r\/a\.md/);
});
