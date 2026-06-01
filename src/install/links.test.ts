import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  lstatSync,
  readlinkSync,
  existsSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applyConfigLinks, planConfigLinks } from "./links.js";
import { makeFakeVendor } from "../vendor/fakeVendor.testutil.js";
import type { Vendor } from "../vendor/schema.js";

function fakeVendor(name: string, home: string, opts: { aliasesFor?: string } = {}): Vendor {
  return makeFakeVendor(name, {
    home,
    aliases: (file) =>
      opts.aliasesFor && file.basename === opts.aliasesFor ? [join(home, "ALIASED.md")] : [],
  });
}

async function withSandbox<T>(
  fn: (paths: {
    repoRoot: string;
    distRoot: string;
    claudeHome: string;
    codexHome: string;
  }) => Promise<T>,
): Promise<T> {
  const sandbox = mkdtempSync(join(tmpdir(), "harness-kit-links-"));
  try {
    const repoRoot = join(sandbox, "repo");
    const distRoot = join(repoRoot, "dist");
    const claudeHome = join(sandbox, "claude");
    const codexHome = join(sandbox, "codex");
    mkdirSync(repoRoot, { recursive: true });
    mkdirSync(distRoot, { recursive: true });
    return await fn({ repoRoot, distRoot, claudeHome, codexHome });
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

function writeManifest(distRoot: string, manifest: unknown): void {
  writeFileSync(join(distRoot, "configs.json"), JSON.stringify(manifest));
}

test("applyConfigLinks links each entry from distRoot into the vendor home at destRel", async () => {
  await withSandbox(async ({ repoRoot, distRoot, claudeHome }) => {
    const compiledDir = join(distRoot, "configs/claude");
    mkdirSync(compiledDir, { recursive: true });
    writeFileSync(join(compiledDir, "settings.json"), "{}");
    writeManifest(distRoot, {
      links: [
        {
          src: "configs/claude/settings.json",
          vendors: ["claude"],
          destRel: "settings.json",
          kind: "file",
        },
      ],
    });
    const claude = fakeVendor("claude", claudeHome);
    await applyConfigLinks({ repoRoot, distRoot, vendors: [claude] });
    const dest = join(claudeHome, "settings.json");
    assert.ok(lstatSync(dest).isSymbolicLink());
    assert.equal(readlinkSync(dest), join(compiledDir, "settings.json"));
  });
});

test("applyConfigLinks mirrors common entries into every targeted vendor", async () => {
  await withSandbox(async ({ repoRoot, distRoot, claudeHome, codexHome }) => {
    const srcDir = join(repoRoot, "src/configs/common");
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(join(srcDir, "AGENTS.md"), "shared");
    writeManifest(distRoot, {
      links: [
        {
          src: "configs/common/AGENTS.md",
          vendors: ["claude", "codex"],
          destRel: "AGENTS.md",
          kind: "file",
        },
      ],
    });
    const claude = fakeVendor("claude", claudeHome);
    const codex = fakeVendor("codex", codexHome);
    await applyConfigLinks({ repoRoot, distRoot, vendors: [claude, codex] });
    assert.ok(lstatSync(join(claudeHome, "AGENTS.md")).isSymbolicLink());
    assert.ok(lstatSync(join(codexHome, "AGENTS.md")).isSymbolicLink());
  });
});

test("applyConfigLinks applies vendor.aliases() for each linked file", async () => {
  await withSandbox(async ({ repoRoot, distRoot, claudeHome }) => {
    const compiledDir = join(distRoot, "configs/common");
    mkdirSync(compiledDir, { recursive: true });
    writeFileSync(join(compiledDir, "AGENTS.md"), "shared");
    writeManifest(distRoot, {
      links: [
        {
          src: "configs/common/AGENTS.md",
          vendors: ["claude"],
          destRel: "AGENTS.md",
          kind: "file",
        },
      ],
    });
    const claude = fakeVendor("claude", claudeHome, { aliasesFor: "AGENTS.md" });
    await applyConfigLinks({ repoRoot, distRoot, vendors: [claude] });
    assert.ok(lstatSync(join(claudeHome, "ALIASED.md")).isSymbolicLink());
    assert.equal(readlinkSync(join(claudeHome, "ALIASED.md")), join(compiledDir, "AGENTS.md"));
  });
});

test("applyConfigLinks backs up non-symlink destinations before linking", async () => {
  await withSandbox(async ({ repoRoot, distRoot, claudeHome }) => {
    const compiledDir = join(distRoot, "configs/claude");
    mkdirSync(compiledDir, { recursive: true });
    writeFileSync(join(compiledDir, "settings.json"), "new");
    mkdirSync(claudeHome, { recursive: true });
    writeFileSync(join(claudeHome, "settings.json"), "user-data");
    writeManifest(distRoot, {
      links: [
        {
          src: "configs/claude/settings.json",
          vendors: ["claude"],
          destRel: "settings.json",
          kind: "file",
        },
      ],
    });
    const claude = fakeVendor("claude", claudeHome);
    await applyConfigLinks({ repoRoot, distRoot, vendors: [claude] });
    assert.equal(readFileSync(join(claudeHome, "settings.json"), "utf8"), "new");
    assert.equal(readFileSync(join(claudeHome, "settings.json.backup"), "utf8"), "user-data");
  });
});

test("applyConfigLinks skips vendors not in the active set", async () => {
  await withSandbox(async ({ repoRoot, distRoot, claudeHome, codexHome }) => {
    const srcDir = join(repoRoot, "src/configs/codex");
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(join(srcDir, "config.toml"), "x = 1");
    writeManifest(distRoot, {
      links: [
        {
          src: "configs/codex/config.toml",
          vendors: ["codex"],
          destRel: "config.toml",
          kind: "file",
        },
      ],
    });
    const claude = fakeVendor("claude", claudeHome);
    await applyConfigLinks({ repoRoot, distRoot, vendors: [claude] });
    assert.ok(!existsSync(join(codexHome, "config.toml")));
  });
});

test("applyConfigLinks removes orphan symlinks that point into the dist tree", async () => {
  await withSandbox(async ({ repoRoot, distRoot, claudeHome }) => {
    const compiledDir = join(distRoot, "configs/claude");
    mkdirSync(compiledDir, { recursive: true });
    writeFileSync(join(compiledDir, "settings.json"), "{}");
    mkdirSync(claudeHome, { recursive: true });
    const orphanSrc = join(distRoot, "configs/claude/removed-feature");
    symlinkSync(orphanSrc, join(claudeHome, "removed-feature"));
    writeManifest(distRoot, {
      links: [
        {
          src: "configs/claude/settings.json",
          vendors: ["claude"],
          destRel: "settings.json",
          kind: "file",
        },
      ],
    });
    const claude = fakeVendor("claude", claudeHome);
    await applyConfigLinks({ repoRoot, distRoot, vendors: [claude] });
    assert.throws(
      () => lstatSync(join(claudeHome, "removed-feature")),
      /ENOENT/,
      "orphan symlink should have been removed",
    );
    assert.ok(lstatSync(join(claudeHome, "settings.json")).isSymbolicLink());
  });
});

test("applyConfigLinks sweeps orphan symlinks living in a subdirectory alongside a planned link", async () => {
  await withSandbox(async ({ repoRoot, distRoot, claudeHome }) => {
    const compiledDir = join(distRoot, "configs/claude/hooks");
    mkdirSync(compiledDir, { recursive: true });
    writeFileSync(join(compiledDir, "pre-push"), "#!/bin/sh\n");
    mkdirSync(join(claudeHome, "hooks"), { recursive: true });
    symlinkSync(
      join(distRoot, "configs/claude/hooks/removed-hook"),
      join(claudeHome, "hooks/removed-hook"),
    );
    writeManifest(distRoot, {
      links: [
        {
          src: "configs/claude/hooks/pre-push",
          vendors: ["claude"],
          destRel: "hooks/pre-push",
          kind: "file",
        },
      ],
    });
    const claude = fakeVendor("claude", claudeHome);
    await applyConfigLinks({ repoRoot, distRoot, vendors: [claude] });
    assert.throws(() => lstatSync(join(claudeHome, "hooks/removed-hook")), /ENOENT/);
    assert.ok(lstatSync(join(claudeHome, "hooks/pre-push")).isSymbolicLink());
  });
});

test("applyConfigLinks removes orphan symlinks pointing anywhere into the dist tree (e.g. removed vendor subtree)", async () => {
  await withSandbox(async ({ repoRoot, distRoot, claudeHome }) => {
    const compiledDir = join(distRoot, "configs/claude");
    mkdirSync(compiledDir, { recursive: true });
    writeFileSync(join(compiledDir, "settings.json"), "{}");
    mkdirSync(claudeHome, { recursive: true });
    const removedVendorOrphan = join(distRoot, "configs/claude/hooks");
    symlinkSync(removedVendorOrphan, join(claudeHome, "hooks"));
    writeManifest(distRoot, {
      links: [
        {
          src: "configs/claude/settings.json",
          vendors: ["claude"],
          destRel: "settings.json",
          kind: "file",
        },
      ],
    });
    const claude = fakeVendor("claude", claudeHome);
    await applyConfigLinks({ repoRoot, distRoot, vendors: [claude] });
    assert.throws(
      () => lstatSync(join(claudeHome, "hooks")),
      /ENOENT/,
      "orphan symlink to a removed dist subtree should have been swept",
    );
  });
});

test("applyConfigLinks leaves untouched symlinks pointing outside the dist tree", async () => {
  await withSandbox(async ({ repoRoot, distRoot, claudeHome }) => {
    mkdirSync(claudeHome, { recursive: true });
    const externalTarget = join(repoRoot, "..", "external", "file.json");
    mkdirSync(join(repoRoot, "..", "external"), { recursive: true });
    writeFileSync(externalTarget, "{}");
    symlinkSync(externalTarget, join(claudeHome, "external.json"));
    writeManifest(distRoot, { links: [] });
    const claude = fakeVendor("claude", claudeHome);
    await applyConfigLinks({ repoRoot, distRoot, vendors: [claude] });
    assert.ok(lstatSync(join(claudeHome, "external.json")).isSymbolicLink());
  });
});

test("applyConfigLinks leaves untouched user symlinks pointing into the repo but outside dist", async () => {
  await withSandbox(async ({ repoRoot, distRoot, claudeHome }) => {
    const userSrcDir = join(repoRoot, "src/configs/claude");
    mkdirSync(userSrcDir, { recursive: true });
    writeFileSync(join(userSrcDir, "user-file.md"), "user");
    mkdirSync(claudeHome, { recursive: true });
    symlinkSync(join(userSrcDir, "user-file.md"), join(claudeHome, "user-file.md"));
    writeManifest(distRoot, { links: [] });
    const claude = fakeVendor("claude", claudeHome);
    await applyConfigLinks({ repoRoot, distRoot, vendors: [claude] });
    assert.ok(lstatSync(join(claudeHome, "user-file.md")).isSymbolicLink());
  });
});

test("applyConfigLinks removes alias-orphan symlinks (vendor stopped emitting an alias)", async () => {
  await withSandbox(async ({ repoRoot, distRoot, claudeHome }) => {
    const compiledDir = join(distRoot, "configs/common");
    mkdirSync(compiledDir, { recursive: true });
    writeFileSync(join(compiledDir, "AGENTS.md"), "shared");
    mkdirSync(claudeHome, { recursive: true });
    symlinkSync(join(compiledDir, "AGENTS.md"), join(claudeHome, "STALE.md"));
    writeManifest(distRoot, {
      links: [
        {
          src: "configs/common/AGENTS.md",
          vendors: ["claude"],
          destRel: "AGENTS.md",
          kind: "file",
        },
      ],
    });
    const claude = fakeVendor("claude", claudeHome);
    await applyConfigLinks({ repoRoot, distRoot, vendors: [claude] });
    assert.throws(() => lstatSync(join(claudeHome, "STALE.md")), /ENOENT/);
    assert.ok(lstatSync(join(claudeHome, "AGENTS.md")).isSymbolicLink());
  });
});

test("applyConfigLinks leaves untouched non-symlink files in the vendor home", async () => {
  await withSandbox(async ({ repoRoot, distRoot, claudeHome }) => {
    mkdirSync(claudeHome, { recursive: true });
    writeFileSync(join(claudeHome, "user-data.json"), "preserve me");
    writeManifest(distRoot, { links: [] });
    const claude = fakeVendor("claude", claudeHome);
    await applyConfigLinks({ repoRoot, distRoot, vendors: [claude] });
    assert.equal(readFileSync(join(claudeHome, "user-data.json"), "utf8"), "preserve me");
  });
});

test("applyConfigLinks tolerates a missing configs.json (no configs to link)", async () => {
  await withSandbox(async ({ repoRoot, distRoot, claudeHome }) => {
    const claude = fakeVendor("claude", claudeHome);
    await applyConfigLinks({ repoRoot, distRoot, vendors: [claude] });
  });
});

test("planConfigLinks returns the planned (src, dest) pairs without touching disk", async () => {
  await withSandbox(async ({ repoRoot, distRoot, claudeHome, codexHome }) => {
    writeManifest(distRoot, {
      links: [
        {
          src: "configs/common/AGENTS.md",
          vendors: ["claude", "codex"],
          destRel: "AGENTS.md",
          kind: "file",
        },
        {
          src: "configs/claude/settings.json",
          vendors: ["claude"],
          destRel: "settings.json",
          kind: "file",
        },
      ],
    });
    const claude = fakeVendor("claude", claudeHome, { aliasesFor: "AGENTS.md" });
    const codex = fakeVendor("codex", codexHome);
    const plan = await planConfigLinks({ repoRoot, distRoot, vendors: [claude, codex] });
    const lines = plan.map((p) => `${p.srcAbs} -> ${p.destAbs}`);
    assert.deepEqual(lines, [
      `${join(distRoot, "configs/common/AGENTS.md")} -> ${join(claudeHome, "AGENTS.md")}`,
      `${join(distRoot, "configs/common/AGENTS.md")} -> ${join(claudeHome, "ALIASED.md")}`,
      `${join(distRoot, "configs/common/AGENTS.md")} -> ${join(codexHome, "AGENTS.md")}`,
      `${join(distRoot, "configs/claude/settings.json")} -> ${join(claudeHome, "settings.json")}`,
    ]);
    assert.ok(!existsSync(join(claudeHome, "AGENTS.md")), "plan must not touch disk");
  });
});
