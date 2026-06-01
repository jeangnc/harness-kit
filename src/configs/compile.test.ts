import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { compileConfigs } from "./compile.js";
import { makeFakeVendor as fakeVendor } from "../vendor/fakeVendor.testutil.js";

const claude = fakeVendor("claude");

interface Sandbox {
  readonly srcRoot: string;
  readonly outRoot: string;
}

async function withSandbox(fn: (s: Sandbox) => Promise<void> | void): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "harness-configs-compile-"));
  const srcRoot = join(root, "src");
  const outRoot = join(root, "dist");
  mkdirSync(srcRoot, { recursive: true });
  try {
    await fn({ srcRoot, outRoot });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("compileConfigs expands {{include:...}} in .md files under <vendor>/configs", async () => {
  await withSandbox(async ({ srcRoot, outRoot }) => {
    mkdirSync(join(srcRoot, "claude/configs"), { recursive: true });
    writeFileSync(
      join(srcRoot, "claude/configs/AGENTS.md"),
      "# Top\n\n{{include:./fragment.md}}\n",
    );
    writeFileSync(join(srcRoot, "claude/configs/fragment.md"), "## Fragment\n\nbody\n");
    await compileConfigs({ srcRoot, outRoot, vendors: [claude] });
    const out = readFileSync(join(outRoot, "claude/configs/AGENTS.md"), "utf8");
    assert.equal(out, "# Top\n\n## Fragment\n\nbody\n");
  });
});

test("compileConfigs copies non-.md files verbatim", async () => {
  await withSandbox(async ({ srcRoot, outRoot }) => {
    mkdirSync(join(srcRoot, "claude/configs"), { recursive: true });
    const original = '{"theme": "dark", "token": "{{include:./oops.md}}"}\n';
    writeFileSync(join(srcRoot, "claude/configs/settings.json"), original);
    await compileConfigs({ srcRoot, outRoot, vendors: [claude] });
    const out = readFileSync(join(outRoot, "claude/configs/settings.json"), "utf8");
    assert.equal(out, original);
  });
});

test("compileConfigs recurses into subdirectories under a vendor configs dir", async () => {
  await withSandbox(async ({ srcRoot, outRoot }) => {
    mkdirSync(join(srcRoot, "claude/configs/agents"), { recursive: true });
    writeFileSync(
      join(srcRoot, "claude/configs/AGENTS.md"),
      "# Top\n\n{{include:./agents/foo.md}}\n",
    );
    writeFileSync(join(srcRoot, "claude/configs/agents/foo.md"), "## Foo\n");
    await compileConfigs({ srcRoot, outRoot, vendors: [claude] });
    assert.equal(
      readFileSync(join(outRoot, "claude/configs/AGENTS.md"), "utf8"),
      "# Top\n\n## Foo\n",
    );
    assert.equal(readFileSync(join(outRoot, "claude/configs/agents/foo.md"), "utf8"), "## Foo\n");
  });
});

test("compileConfigs errors when a .md file uses an unknown placeholder prefix", async () => {
  await withSandbox(async ({ srcRoot, outRoot }) => {
    mkdirSync(join(srcRoot, "claude/configs"), { recursive: true });
    writeFileSync(join(srcRoot, "claude/configs/AGENTS.md"), "# Top\n\n{{bogus:value}}\n");
    await assert.rejects(
      async () => compileConfigs({ srcRoot, outRoot, vendors: [claude] }),
      /bogus/,
    );
  });
});

test("compileConfigs blocks {{include:...}} paths that escape the vendor configs dir", async () => {
  await withSandbox(async ({ srcRoot, outRoot }) => {
    mkdirSync(join(srcRoot, "claude/configs"), { recursive: true });
    writeFileSync(join(srcRoot, "outside.md"), "leaked\n");
    writeFileSync(join(srcRoot, "claude/configs/AGENTS.md"), "{{include:../../outside.md}}\n");
    await assert.rejects(
      async () => compileConfigs({ srcRoot, outRoot, vendors: [claude] }),
      /escapes/,
    );
  });
});

test("compileConfigs skips vendors that have no configs/ dir", async () => {
  await withSandbox(async ({ srcRoot, outRoot }) => {
    mkdirSync(join(srcRoot, "claude/configs"), { recursive: true });
    writeFileSync(join(srcRoot, "claude/configs/settings.md"), "claude only\n");
    const gemini = fakeVendor("gemini");
    await compileConfigs({ srcRoot, outRoot, vendors: [claude, gemini] });
    assert.equal(existsSync(join(outRoot, "claude/configs/settings.md")), true);
    assert.equal(existsSync(join(outRoot, "gemini/configs")), false);
  });
});

test("compileConfigs resolves {{skill:plugin:name}} via the provided localIds", async () => {
  await withSandbox(async ({ srcRoot, outRoot }) => {
    mkdirSync(join(srcRoot, "claude/configs"), { recursive: true });
    writeFileSync(join(srcRoot, "claude/configs/AGENTS.md"), "use {{skill:foo:bar}}\n");
    await compileConfigs({
      srcRoot,
      outRoot,
      vendors: [claude],
      localIds: {
        skills: new Set(["foo:bar"]),
        commands: new Set(),
        agents: new Set(),
      },
      installedIndex: { skills: new Map(), commands: new Map(), agents: new Map() },
    });
    const out = readFileSync(join(outRoot, "claude/configs/AGENTS.md"), "utf8");
    assert.equal(out, "use `foo:bar`\n");
  });
});

test("compileConfigs ignores dotfiles and .fragments/", async () => {
  await withSandbox(async ({ srcRoot, outRoot }) => {
    mkdirSync(join(srcRoot, "claude/configs/.fragments"), { recursive: true });
    writeFileSync(join(srcRoot, "claude/configs/.fragments/x.md"), "");
    writeFileSync(join(srcRoot, "claude/configs/.gitkeep"), "");
    writeFileSync(join(srcRoot, "claude/configs/AGENTS.md"), "x\n");
    await compileConfigs({ srcRoot, outRoot, vendors: [claude] });
    assert.equal(existsSync(join(outRoot, "claude/configs/.gitkeep")), false);
    assert.equal(existsSync(join(outRoot, "claude/configs/.fragments")), false);
    assert.equal(existsSync(join(outRoot, "claude/configs/AGENTS.md")), true);
  });
});

test("compileConfigs is a no-op when the vendor has no configs/ dir", async () => {
  await withSandbox(async ({ srcRoot, outRoot }) => {
    await compileConfigs({ srcRoot, outRoot, vendors: [claude] });
    assert.equal(existsSync(join(outRoot, "claude/configs")), false);
  });
});
