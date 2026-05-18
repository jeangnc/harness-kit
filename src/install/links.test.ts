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
import type { Vendor } from "../vendor/schema.js";

function fakeVendor(name: string, home: string, opts: { aliasesFor?: string } = {}): Vendor {
  return {
    name,
    home,
    pluginManifestPath: `.${name}-plugin/plugin.json`,
    aliases: (file) =>
      opts.aliasesFor && file.basename === opts.aliasesFor ? [join(home, "ALIASED.md")] : [],
    emitPluginManifest: async () => undefined,
    install: async () => undefined,
    uninstall: async () => undefined,
  };
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

test("applyConfigLinks links each entry into the vendor home at destRel", async () => {
  await withSandbox(async ({ repoRoot, distRoot, claudeHome }) => {
    const srcDir = join(repoRoot, "src/configs/claude");
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(join(srcDir, "settings.json"), "{}");
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
    assert.equal(readlinkSync(dest), join(srcDir, "settings.json"));
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
    const srcDir = join(repoRoot, "src/configs/common");
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(join(srcDir, "AGENTS.md"), "shared");
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
    assert.equal(readlinkSync(join(claudeHome, "ALIASED.md")), join(srcDir, "AGENTS.md"));
  });
});

test("applyConfigLinks backs up non-symlink destinations before linking", async () => {
  await withSandbox(async ({ repoRoot, distRoot, claudeHome }) => {
    const srcDir = join(repoRoot, "src/configs/claude");
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(join(srcDir, "settings.json"), "new");
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

test("applyConfigLinks removes orphan symlinks that point into the managed source tree", async () => {
  await withSandbox(async ({ repoRoot, distRoot, claudeHome }) => {
    const srcDir = join(repoRoot, "src/configs/claude");
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(join(srcDir, "settings.json"), "{}");
    mkdirSync(claudeHome, { recursive: true });
    const orphanSrc = join(repoRoot, "src/configs/claude/removed-feature");
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

test("applyConfigLinks leaves untouched symlinks pointing outside the managed source tree", async () => {
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

test("applyConfigLinks removes alias-orphan symlinks (vendor stopped emitting an alias)", async () => {
  await withSandbox(async ({ repoRoot, distRoot, claudeHome }) => {
    const srcDir = join(repoRoot, "src/configs/common");
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(join(srcDir, "AGENTS.md"), "shared");
    mkdirSync(claudeHome, { recursive: true });
    symlinkSync(join(srcDir, "AGENTS.md"), join(claudeHome, "STALE.md"));
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
      `${join(repoRoot, "src/configs/common/AGENTS.md")} -> ${join(claudeHome, "AGENTS.md")}`,
      `${join(repoRoot, "src/configs/common/AGENTS.md")} -> ${join(claudeHome, "ALIASED.md")}`,
      `${join(repoRoot, "src/configs/common/AGENTS.md")} -> ${join(codexHome, "AGENTS.md")}`,
      `${join(repoRoot, "src/configs/claude/settings.json")} -> ${join(claudeHome, "settings.json")}`,
    ]);
    assert.ok(!existsSync(join(claudeHome, "AGENTS.md")), "plan must not touch disk");
  });
});
