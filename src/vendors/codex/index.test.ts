import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { codexVendor, makeCodexVendor } from "./index.js";
import type { CommandRunner } from "../../install/runner.js";
import type { VendorInstallContext } from "../../vendor/schema.js";

interface Call {
  readonly cmd: string;
  readonly args: readonly string[];
}

function recordingRunner(): { run: CommandRunner; calls: Call[] } {
  const calls: Call[] = [];
  const run: CommandRunner = async (cmd, args) => {
    calls.push({ cmd, args });
  };
  return { run, calls };
}

function makePluginDir(root: string, name: string, fileContent: string): string {
  const dir = join(root, "plugins", "codex", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "marker.txt"), fileContent);
  return dir;
}

async function withSandbox(
  fn: (ctx: { distRoot: string; codexHome: string }) => Promise<void>,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "harness-codex-test-"));
  const distRoot = join(root, "dist");
  const codexHome = join(root, "home");
  mkdirSync(distRoot, { recursive: true });
  mkdirSync(codexHome, { recursive: true });
  try {
    await fn({ distRoot, codexHome });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("codexVendor default home is ~/.codex", () => {
  assert.equal(codexVendor.name, "codex");
  assert.match(codexVendor.home, /\.codex$/);
  assert.equal(codexVendor.pluginManifestPath, ".codex-plugin/plugin.json");
});

test("codexVendor.pluginOutDir places plugins under <outRoot>/codex/plugins/<plugin>", () => {
  assert.equal(codexVendor.pluginOutDir("/tmp/dist", "alpha"), "/tmp/dist/codex/plugins/alpha");
});

test("codexVendor.configsOutDir places configs under <outRoot>/codex/configs", () => {
  assert.equal(codexVendor.configsOutDir("/tmp/dist"), "/tmp/dist/codex/configs");
});

test("codexVendor declares no aliases hook", () => {
  const v = makeCodexVendor("/home/test/.codex");
  assert.equal(v.aliases, undefined);
});

test("codexVendor.install primes cache + registers marketplace", async () => {
  await withSandbox(async ({ distRoot, codexHome }) => {
    const alphaPath = makePluginDir(distRoot, "alpha", "alpha-content");
    const { run, calls } = recordingRunner();
    const ctx: VendorInstallContext = {
      distRoot,
      marketplace: "test-market",
      plugins: [{ name: "alpha", path: alphaPath, version: "1.2.3" }],
      mode: "remote",
      run,
      log: () => undefined,
    };
    await makeCodexVendor(codexHome).install(ctx);

    const cached = join(codexHome, "plugins/cache/test-market/alpha/1.2.3/marker.txt");
    assert.equal(existsSync(cached), true);
    assert.equal(readFileSync(cached, "utf8"), "alpha-content");
    const cmds = calls.map((c) => [c.cmd, ...c.args].join(" "));
    assert.deepEqual(cmds, [`codex plugin marketplace add ${distRoot}`]);
  });
});

test("codexVendor.install is a no-op when no plugins", async () => {
  await withSandbox(async ({ distRoot, codexHome }) => {
    const { run, calls } = recordingRunner();
    await makeCodexVendor(codexHome).install({
      distRoot,
      marketplace: "m",
      plugins: [],
      mode: "remote",
      run,
      log: () => undefined,
    });
    assert.equal(calls.length, 0);
  });
});

test("codexVendor.install wipes any pre-existing marketplace cache", async () => {
  await withSandbox(async ({ distRoot, codexHome }) => {
    const stale = join(codexHome, "plugins/cache/test-market/stale-plugin/9.9.9");
    mkdirSync(stale, { recursive: true });
    writeFileSync(join(stale, "old.txt"), "old");
    const alphaPath = makePluginDir(distRoot, "alpha", "fresh");
    const { run } = recordingRunner();
    await makeCodexVendor(codexHome).install({
      distRoot,
      marketplace: "test-market",
      plugins: [{ name: "alpha", path: alphaPath, version: "1.0.0" }],
      mode: "remote",
      run,
      log: () => undefined,
    });
    assert.equal(existsSync(stale), false);
    assert.equal(
      existsSync(join(codexHome, "plugins/cache/test-market/alpha/1.0.0/marker.txt")),
      true,
    );
  });
});

test("codexVendor.uninstall removes marketplace cache + calls codex CLI", async () => {
  await withSandbox(async ({ distRoot, codexHome }) => {
    const cacheDir = join(codexHome, "plugins/cache/test-market");
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, "stale.txt"), "x");
    const { run, calls } = recordingRunner();
    await makeCodexVendor(codexHome).uninstall({
      distRoot,
      marketplace: "test-market",
      plugins: [],
      mode: "remote",
      run,
      log: () => undefined,
    });
    assert.equal(existsSync(cacheDir), false);
    const cmds = calls.map((c) => [c.cmd, ...c.args].join(" "));
    assert.deepEqual(cmds, ["codex plugin marketplace remove test-market"]);
  });
});
