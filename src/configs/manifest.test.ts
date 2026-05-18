import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildConfigsManifest } from "./manifest.js";

interface Sandbox {
  readonly srcRoot: string;
  readonly configsRoot: string;
}

async function withSandbox(fn: (s: Sandbox) => Promise<void> | void): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "harness-configs-test-"));
  const srcRoot = join(root, "src");
  const configsRoot = join(srcRoot, "configs");
  mkdirSync(configsRoot, { recursive: true });
  try {
    await fn({ srcRoot, configsRoot });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("buildConfigsManifest returns empty links when src/configs is missing", async () => {
  await withSandbox(async ({ srcRoot, configsRoot }) => {
    rmSync(configsRoot, { recursive: true, force: true });
    const m = await buildConfigsManifest({ srcRoot, vendors: ["claude", "codex"] });
    assert.deepEqual(m, { links: [] });
  });
});

test("buildConfigsManifest emits common files for every declared vendor", async () => {
  await withSandbox(async ({ srcRoot, configsRoot }) => {
    mkdirSync(join(configsRoot, "common"));
    writeFileSync(join(configsRoot, "common", "AGENTS.md"), "x");
    const m = await buildConfigsManifest({ srcRoot, vendors: ["claude", "codex"] });
    assert.deepEqual(m.links, [
      {
        src: "configs/common/AGENTS.md",
        vendors: ["claude", "codex"],
        destRel: "AGENTS.md",
        kind: "file",
      },
    ]);
  });
});

test("buildConfigsManifest emits per-vendor entries scoped to that vendor only", async () => {
  await withSandbox(async ({ srcRoot, configsRoot }) => {
    mkdirSync(join(configsRoot, "claude"));
    writeFileSync(join(configsRoot, "claude", "settings.json"), "{}");
    mkdirSync(join(configsRoot, "codex"));
    writeFileSync(join(configsRoot, "codex", "config.toml"), "");
    const m = await buildConfigsManifest({ srcRoot, vendors: ["claude", "codex"] });
    assert.deepEqual(
      m.links.toSorted((a, b) => a.src.localeCompare(b.src)),
      [
        {
          src: "configs/claude/settings.json",
          vendors: ["claude"],
          destRel: "settings.json",
          kind: "file",
        },
        {
          src: "configs/codex/config.toml",
          vendors: ["codex"],
          destRel: "config.toml",
          kind: "file",
        },
      ],
    );
  });
});

test("buildConfigsManifest emits directory entries with kind: dir (no recursion)", async () => {
  await withSandbox(async ({ srcRoot, configsRoot }) => {
    mkdirSync(join(configsRoot, "claude", "hooks"), { recursive: true });
    writeFileSync(join(configsRoot, "claude", "hooks", "pre.sh"), "");
    writeFileSync(join(configsRoot, "claude", "hooks", "post.sh"), "");
    const m = await buildConfigsManifest({ srcRoot, vendors: ["claude"] });
    assert.deepEqual(m.links, [
      { src: "configs/claude/hooks", vendors: ["claude"], destRel: "hooks", kind: "dir" },
    ]);
  });
});

test("buildConfigsManifest skips per-vendor dirs not in the declared vendor list", async () => {
  await withSandbox(async ({ srcRoot, configsRoot }) => {
    mkdirSync(join(configsRoot, "claude"));
    writeFileSync(join(configsRoot, "claude", "settings.json"), "{}");
    mkdirSync(join(configsRoot, "gemini"));
    writeFileSync(join(configsRoot, "gemini", "config.json"), "{}");
    const m = await buildConfigsManifest({ srcRoot, vendors: ["claude"] });
    assert.deepEqual(m.links, [
      {
        src: "configs/claude/settings.json",
        vendors: ["claude"],
        destRel: "settings.json",
        kind: "file",
      },
    ]);
  });
});

test("buildConfigsManifest ignores dotfiles at the top level (e.g. .gitkeep)", async () => {
  await withSandbox(async ({ srcRoot, configsRoot }) => {
    mkdirSync(join(configsRoot, "common"));
    writeFileSync(join(configsRoot, "common", ".gitkeep"), "");
    writeFileSync(join(configsRoot, "common", "AGENTS.md"), "x");
    const m = await buildConfigsManifest({ srcRoot, vendors: ["claude"] });
    assert.deepEqual(m.links, [
      { src: "configs/common/AGENTS.md", vendors: ["claude"], destRel: "AGENTS.md", kind: "file" },
    ]);
  });
});

test("buildConfigsManifest emits stable order: scope (common, then vendors in declared order), then name", async () => {
  await withSandbox(async ({ srcRoot, configsRoot }) => {
    mkdirSync(join(configsRoot, "common"));
    writeFileSync(join(configsRoot, "common", "zeta.md"), "");
    writeFileSync(join(configsRoot, "common", "alpha.md"), "");
    mkdirSync(join(configsRoot, "codex"));
    writeFileSync(join(configsRoot, "codex", "config.toml"), "");
    mkdirSync(join(configsRoot, "claude"));
    writeFileSync(join(configsRoot, "claude", "settings.json"), "{}");
    const m = await buildConfigsManifest({ srcRoot, vendors: ["claude", "codex"] });
    assert.deepEqual(
      m.links.map((l) => l.src),
      [
        "configs/common/alpha.md",
        "configs/common/zeta.md",
        "configs/claude/settings.json",
        "configs/codex/config.toml",
      ],
    );
  });
});
