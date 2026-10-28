import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, readFile, lstat, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateRuntime, assertRuntimeDetached, installDefaults } from "./runtime.js";
import { makeCodexVendor } from "../vendors/codex/index.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "runtime-test-"));
  const distRoot = join(root, "dist");
  const home = join(root, "home");
  await mkdir(join(distRoot, "codex/configs"), { recursive: true });
  await mkdir(home);
  const source = join(distRoot, "codex/configs/config.toml");
  await writeFile(source, 'model = "foo"\n', { mode: 0o640 });
  await symlink(source, join(home, "config.toml"));
  return { root, source, home, distRoot, vendors: [makeCodexVendor(home)] };
}

test("migration preserves linked runtime bytes and permissions and is idempotent", async () => {
  const f = await fixture();
  const result = await migrateRuntime(f);
  assert.equal(result.length, 1);
  assert.equal((await lstat(join(f.home, "config.toml"))).isSymbolicLink(), false);
  assert.equal(await readFile(join(f.home, "config.toml"), "utf8"), 'model = "foo"\n');
  assert.equal((await stat(join(f.home, "config.toml"))).mode & 0o777, 0o640);
  assert.equal(await readFile(result[0]!.backup, "utf8"), 'model = "foo"\n');
  assert.deepEqual(await migrateRuntime(f), []);
});

test("compile preflight detects links through parent directories", async () => {
  const f = await fixture();
  await symlink(join(f.distRoot, "codex/configs"), join(f.home, "profiles"));
  await assert.rejects(assertRuntimeDetached(f), /migrate-runtime/);
  await migrateRuntime(f);
  await assertRuntimeDetached(f);
});

test("dry-run migration and foreign links remain untouched", async () => {
  const f = await fixture();
  const foreign = join(f.root, "foo");
  await writeFile(foreign, "foo");
  await symlink(foreign, join(f.home, "AGENTS.md"));
  await migrateRuntime({ ...f, dryRun: true });
  assert.equal((await lstat(join(f.home, "config.toml"))).isSymbolicLink(), true);
  await migrateRuntime(f);
  assert.equal((await lstat(join(f.home, "AGENTS.md"))).isSymbolicLink(), true);
});

test("defaults publish a regular copy without touching runtime settings", async () => {
  const f = await fixture();
  const target = join(f.root, "etc/codex/config.toml");
  await installDefaults({ distRoot: f.distRoot, target });
  assert.equal((await lstat(target)).isSymbolicLink(), false);
  await writeFile(f.source, "changed");
  assert.equal(await readFile(target, "utf8"), 'model = "foo"\n');
  assert.equal((await lstat(join(f.home, "config.toml"))).isSymbolicLink(), true);
});

test("migration recovers a directory interrupted after displacing its link", async () => {
  const f = await fixture();
  const staging = join(f.home, ".harness-runtime-foo");
  await mkdir(staging);
  await writeFile(join(staging, "target"), "profiles");
  await symlink(join(f.distRoot, "codex/configs"), join(staging, "original-link"));
  await mkdir(join(staging, "incoming"));
  await writeFile(join(staging, "incoming/config.toml"), "preserved");
  await migrateRuntime(f);
  assert.equal(await readFile(join(f.home, "profiles/config.toml"), "utf8"), "preserved");
});

test("compile refuses an interrupted directory migration", async () => {
  const f = await fixture();
  await migrateRuntime(f);
  const staging = join(f.home, ".harness-runtime-foo");
  await mkdir(staging);
  await writeFile(join(staging, "target"), "profiles");
  await symlink(join(f.distRoot, "codex/configs"), join(staging, "original-link"));
  await assert.rejects(assertRuntimeDetached(f), /interrupted migration/);
});

test("migration detaches a linked runtime parent without changing generated files", async () => {
  const f = await fixture();
  const parent = join(f.root, "bar");
  await mkdir(join(f.distRoot, "foo"));
  await mkdir(join(f.distRoot, "foo/home"));
  await writeFile(join(f.distRoot, "foo/home/settings.json"), "preserved");
  await symlink(join(f.distRoot, "foo"), parent);
  const vendor = { ...makeCodexVendor(join(parent, "home")), name: "claude" };
  await migrateRuntime({ distRoot: f.distRoot, vendors: [vendor] });
  assert.equal((await lstat(parent)).isSymbolicLink(), false);
  await writeFile(join(parent, "home/settings.json"), "changed");
  assert.equal(await readFile(join(f.distRoot, "foo/home/settings.json"), "utf8"), "preserved");
});

test("defaults preserve the previous machine file before replacement", async () => {
  const f = await fixture();
  const target = join(f.root, "config.toml");
  await writeFile(target, "previous");
  const backup = await installDefaults({ distRoot: f.distRoot, target });
  assert.ok(backup);
  assert.equal(await readFile(backup, "utf8"), "previous");
});

test("compile refuses a dangling runtime link into generated output", async () => {
  const f = await fixture();
  await migrateRuntime(f);
  await symlink(join(f.distRoot, "codex/configs/foo.toml"), join(f.home, "foo.config.toml"));
  await assert.rejects(assertRuntimeDetached(f), /migrate-runtime/);
});

test("migration recovers an interrupted nested profile directory", async () => {
  const f = await fixture();
  await migrateRuntime(f);
  const staging = join(f.home, "profiles/.harness-runtime-foo");
  await mkdir(staging, { recursive: true });
  await writeFile(join(staging, "target"), "foo");
  await symlink(join(f.distRoot, "codex/configs"), join(staging, "original-link"));
  await mkdir(join(staging, "incoming"));
  await writeFile(join(staging, "incoming/config.toml"), "preserved");
  await assert.rejects(assertRuntimeDetached(f), /interrupted migration/);
  await migrateRuntime(f);
  assert.equal(await readFile(join(f.home, "profiles/foo/config.toml"), "utf8"), "preserved");
});

test("completed directory migration permits later removal of that directory", async () => {
  const f = await fixture();
  await symlink(join(f.distRoot, "codex/configs"), join(f.home, "profiles"));
  await migrateRuntime(f);
  await rm(join(f.home, "profiles"), { recursive: true });
  await assertRuntimeDetached(f);
  assert.deepEqual(await migrateRuntime(f), []);
});

test("migration finalizes an interruption after placing the preserved directory", async () => {
  const f = await fixture();
  await migrateRuntime(f);
  const staging = join(f.home, ".harness-runtime-foo");
  await mkdir(staging);
  await writeFile(join(staging, "target"), "profiles");
  await symlink(join(f.distRoot, "codex/configs"), join(staging, "original-link"));
  await mkdir(join(f.home, "profiles"));
  await writeFile(join(f.home, "profiles/config.toml"), "preserved");
  await migrateRuntime({ ...f, dryRun: true });
  assert.equal(await readFile(join(staging, "target"), "utf8"), "profiles");
  await migrateRuntime(f);
  await rm(join(f.home, "profiles"), { recursive: true });
  await assertRuntimeDetached(f);
});
