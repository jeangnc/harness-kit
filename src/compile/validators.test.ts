import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildRegistry } from "./validators.js";
import { precomputeExistingRefs } from "./frontmatter.js";
import { substitute } from "../placeholders/index.js";
import type { InstalledIndex } from "../installed.js";
import type { LocalIds } from "../layout/index.js";

const emptyLocalIds: LocalIds = {
  skills: new Set(),
  commands: new Set(),
  agents: new Set(),
};

const emptyInstalledIndex: InstalledIndex = {
  skills: new Map(),
  commands: new Map(),
  agents: new Map(),
};

async function substituteRef(skillDir: string, value: string) {
  const body = `see {{ref:${value}}}`;
  const existingRefs = await precomputeExistingRefs(body, skillDir);
  const registry = buildRegistry(
    undefined,
    emptyLocalIds,
    emptyInstalledIndex,
    existingRefs,
    skillDir,
  );
  return substitute(body, registry);
}

async function withSkillDir<T>(setup: (skillDir: string) => Promise<T>): Promise<T> {
  const skillDir = mkdtempSync(join(tmpdir(), "harness-kit-ref-"));
  try {
    return await setup(skillDir);
  } finally {
    rmSync(skillDir, { recursive: true, force: true });
  }
}

test("ref to a file inside a dot-dir that ships nowhere fails with the unemitted-target error", async () => {
  await withSkillDir(async (skillDir) => {
    mkdirSync(join(skillDir, ".fragments"), { recursive: true });
    writeFileSync(join(skillDir, ".fragments/foo.md"), "x");

    const result = await substituteRef(skillDir, "./.fragments/foo.md");

    assert.equal(result.ok, false);
    assert.match(result.ok ? "" : result.errors.join("\n"), /will not emit to dist/);
    assert.match(result.ok ? "" : result.errors.join("\n"), /\.fragments/);
  });
});

test("ref to a nested non-dot path that ships passes and renders the literal path", async () => {
  await withSkillDir(async (skillDir) => {
    mkdirSync(join(skillDir, "shared"), { recursive: true });
    writeFileSync(join(skillDir, "shared/x.md"), "x");

    const result = await substituteRef(skillDir, "./shared/x.md");

    assert.equal(result.ok, true);
    assert.equal(result.ok && result.rendered, "see `./shared/x.md`");
  });
});

test("ref to a plain in-folder companion that ships passes", async () => {
  await withSkillDir(async (skillDir) => {
    writeFileSync(join(skillDir, "companion.md"), "x");

    const result = await substituteRef(skillDir, "./companion.md");

    assert.equal(result.ok, true);
    assert.equal(result.ok && result.rendered, "see `./companion.md`");
  });
});

test("ref to a passthrough dotfile passes", async () => {
  await withSkillDir(async (skillDir) => {
    writeFileSync(join(skillDir, ".mcp.json"), "{}");

    const result = await substituteRef(skillDir, "./.mcp.json");

    assert.equal(result.ok, true);
    assert.equal(result.ok && result.rendered, "see `./.mcp.json`");
  });
});

test("ref to an unemitted dot-dir path that also does not exist reports the unemitted reason", async () => {
  await withSkillDir(async (skillDir) => {
    const result = await substituteRef(skillDir, "./.fragments/missing.md");

    assert.equal(result.ok, false);
    assert.match(result.ok ? "" : result.errors.join("\n"), /will not emit to dist/);
  });
});
