import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { claudeVendor, makeClaudeVendor } from "./index.js";
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

function ctx(over: Partial<VendorInstallContext> = {}): VendorInstallContext {
  const { run } = recordingRunner();
  return {
    distRoot: "/tmp/dist",
    marketplace: "test-market",
    plugins: [],
    run,
    log: () => undefined,
    ...over,
  };
}

test("claudeVendor default home is ~/.claude", () => {
  assert.equal(claudeVendor.name, "claude");
  assert.match(claudeVendor.home, /\.claude$/);
  assert.equal(claudeVendor.pluginManifestPath, ".claude-plugin/plugin.json");
});

test("claudeVendor.aliases mirrors AGENTS.md to CLAUDE.md in the vendor home", () => {
  const v = makeClaudeVendor("/home/test/.claude");
  const aliases = v.aliases?.({
    srcAbs: "/repo/src/configs/common/AGENTS.md",
    destAbs: "/home/test/.claude/AGENTS.md",
    destRel: "AGENTS.md",
    basename: "AGENTS.md",
  });
  assert.deepEqual(aliases, ["/home/test/.claude/CLAUDE.md"]);
});

test("claudeVendor.aliases returns empty for non-AGENTS files", () => {
  const v = makeClaudeVendor("/home/test/.claude");
  const aliases = v.aliases?.({
    srcAbs: "/repo/src/configs/claude/settings.json",
    destAbs: "/home/test/.claude/settings.json",
    destRel: "settings.json",
    basename: "settings.json",
  });
  assert.deepEqual(aliases, []);
});

test("claudeVendor.install uninstalls + installs each plugin via claude CLI", async () => {
  const { run, calls } = recordingRunner();
  await claudeVendor.install(
    ctx({
      run,
      plugins: [
        { name: "alpha", path: "/tmp/dist/plugins/claude/alpha", version: "1.0.0" },
        { name: "beta", path: "/tmp/dist/plugins/claude/beta", version: "0.2.0" },
      ],
    }),
  );
  const cmds = calls.map((c) => [c.cmd, ...c.args].join(" "));
  assert.deepEqual(cmds, [
    "claude plugin uninstall alpha@test-market",
    "claude plugin uninstall beta@test-market",
    "claude plugin install alpha@test-market",
    "claude plugin install beta@test-market",
  ]);
});

test("claudeVendor.install is a no-op when no plugins", async () => {
  const { run, calls } = recordingRunner();
  await claudeVendor.install(ctx({ run, plugins: [] }));
  assert.equal(calls.length, 0);
});

test("claudeVendor.uninstall uninstalls each plugin + removes marketplace", async () => {
  const { run, calls } = recordingRunner();
  await claudeVendor.uninstall(
    ctx({
      run,
      plugins: [{ name: "alpha", path: "/x", version: "1.0.0" }],
    }),
  );
  const cmds = calls.map((c) => [c.cmd, ...c.args].join(" "));
  assert.deepEqual(cmds, [
    "claude plugin uninstall alpha@test-market",
    "claude plugin marketplace remove test-market",
  ]);
});

test("makeClaudeVendor honors a custom home for cache removal path semantics", () => {
  const v = makeClaudeVendor("/custom/.claude");
  assert.equal(v.home, "/custom/.claude");
  assert.deepEqual(
    v.aliases?.({
      srcAbs: "/x/AGENTS.md",
      destAbs: join(v.home, "AGENTS.md"),
      destRel: "AGENTS.md",
      basename: "AGENTS.md",
    }),
    ["/custom/.claude/CLAUDE.md"],
  );
});
