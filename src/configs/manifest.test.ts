import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildConfigsManifest } from "./manifest.js";
import { makeFakeVendor as fakeVendor } from "../vendor/fakeVendor.testutil.js";

const claude = fakeVendor("claude");
const codex = fakeVendor("codex");

interface Sandbox {
  readonly outRoot: string;
}

async function withSandbox(fn: (s: Sandbox) => Promise<void> | void): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "harness-configs-test-"));
  const outRoot = join(root, "dist");
  mkdirSync(outRoot, { recursive: true });
  try {
    await fn({ outRoot });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("buildConfigsManifest returns empty links when no vendor has a configs/ dir", async () => {
  await withSandbox(async ({ outRoot }) => {
    const m = await buildConfigsManifest({ outRoot, vendors: [claude, codex] });
    assert.deepEqual(m, { links: [] });
  });
});

test("buildConfigsManifest emits one link per vendor file under <vendor>/configs/", async () => {
  await withSandbox(async ({ outRoot }) => {
    mkdirSync(join(outRoot, "claude/configs"), { recursive: true });
    writeFileSync(join(outRoot, "claude/configs/settings.json"), "{}");
    mkdirSync(join(outRoot, "codex/configs"), { recursive: true });
    writeFileSync(join(outRoot, "codex/configs/config.toml"), "");
    const m = await buildConfigsManifest({ outRoot, vendors: [claude, codex] });
    assert.deepEqual(
      m.links.toSorted((a, b) => a.src.localeCompare(b.src)),
      [
        {
          src: "claude/configs/settings.json",
          vendors: ["claude"],
          destRel: "settings.json",
          kind: "file",
        },
        {
          src: "codex/configs/config.toml",
          vendors: ["codex"],
          destRel: "config.toml",
          kind: "file",
        },
      ],
    );
  });
});

test("buildConfigsManifest emits one link per (vendor, file) even when filenames overlap", async () => {
  await withSandbox(async ({ outRoot }) => {
    mkdirSync(join(outRoot, "claude/configs"), { recursive: true });
    writeFileSync(join(outRoot, "claude/configs/AGENTS.md"), "x");
    mkdirSync(join(outRoot, "codex/configs"), { recursive: true });
    writeFileSync(join(outRoot, "codex/configs/AGENTS.md"), "x");
    const m = await buildConfigsManifest({ outRoot, vendors: [claude, codex] });
    assert.deepEqual(m.links, [
      { src: "claude/configs/AGENTS.md", vendors: ["claude"], destRel: "AGENTS.md", kind: "file" },
      { src: "codex/configs/AGENTS.md", vendors: ["codex"], destRel: "AGENTS.md", kind: "file" },
    ]);
  });
});

test("buildConfigsManifest emits directory entries with kind: dir (no recursion)", async () => {
  await withSandbox(async ({ outRoot }) => {
    mkdirSync(join(outRoot, "claude/configs/hooks"), { recursive: true });
    writeFileSync(join(outRoot, "claude/configs/hooks/pre.sh"), "");
    writeFileSync(join(outRoot, "claude/configs/hooks/post.sh"), "");
    const m = await buildConfigsManifest({ outRoot, vendors: [claude] });
    assert.deepEqual(m.links, [
      { src: "claude/configs/hooks", vendors: ["claude"], destRel: "hooks", kind: "dir" },
    ]);
  });
});

test("buildConfigsManifest skips vendor configs dirs not in the declared vendor list", async () => {
  await withSandbox(async ({ outRoot }) => {
    mkdirSync(join(outRoot, "claude/configs"), { recursive: true });
    writeFileSync(join(outRoot, "claude/configs/settings.json"), "{}");
    mkdirSync(join(outRoot, "gemini/configs"), { recursive: true });
    writeFileSync(join(outRoot, "gemini/configs/config.json"), "{}");
    const m = await buildConfigsManifest({ outRoot, vendors: [claude] });
    assert.deepEqual(m.links, [
      {
        src: "claude/configs/settings.json",
        vendors: ["claude"],
        destRel: "settings.json",
        kind: "file",
      },
    ]);
  });
});

test("buildConfigsManifest ignores dotfiles at the top level (e.g. .gitkeep, .fragments/)", async () => {
  await withSandbox(async ({ outRoot }) => {
    mkdirSync(join(outRoot, "claude/configs/.fragments"), { recursive: true });
    writeFileSync(join(outRoot, "claude/configs/.fragments/x.md"), "");
    writeFileSync(join(outRoot, "claude/configs/.gitkeep"), "");
    writeFileSync(join(outRoot, "claude/configs/AGENTS.md"), "x");
    const m = await buildConfigsManifest({ outRoot, vendors: [claude] });
    assert.deepEqual(m.links, [
      { src: "claude/configs/AGENTS.md", vendors: ["claude"], destRel: "AGENTS.md", kind: "file" },
    ]);
  });
});

test("buildConfigsManifest emits stable order: vendor in declared order, then name", async () => {
  await withSandbox(async ({ outRoot }) => {
    mkdirSync(join(outRoot, "claude/configs"), { recursive: true });
    writeFileSync(join(outRoot, "claude/configs/zeta.md"), "");
    writeFileSync(join(outRoot, "claude/configs/alpha.md"), "");
    mkdirSync(join(outRoot, "codex/configs"), { recursive: true });
    writeFileSync(join(outRoot, "codex/configs/config.toml"), "");
    const m = await buildConfigsManifest({ outRoot, vendors: [claude, codex] });
    assert.deepEqual(
      m.links.map((l) => l.src),
      ["claude/configs/alpha.md", "claude/configs/zeta.md", "codex/configs/config.toml"],
    );
  });
});
