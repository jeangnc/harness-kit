import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { claudeVendor, makeClaudeVendor, readEnabledPlugins } from "./index.js";
import type { CommandRunner } from "../../install/runner.js";
import type { Marketplace } from "../../marketplace/index.js";
import type { VendorInstallContext } from "../../vendor/schema.js";

function distWithSettings(enabledPlugins: unknown): string {
  const dist = mkdtempSync(join(tmpdir(), "harness-kit-claude-settings-"));
  const configsDir = join(dist, "claude/configs");
  mkdirSync(configsDir, { recursive: true });
  const body = enabledPlugins === undefined ? {} : { enabledPlugins };
  writeFileSync(join(configsDir, "settings.json"), JSON.stringify(body));
  return dist;
}

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
    mode: "local",
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

test("claudeVendor.pluginOutDir places plugins under <outRoot>/claude/plugins/<plugin>", () => {
  assert.equal(claudeVendor.pluginOutDir("/tmp/dist", "alpha"), "/tmp/dist/claude/plugins/alpha");
});

test("claudeVendor.configsOutDir places configs under <outRoot>/claude/configs", () => {
  assert.equal(claudeVendor.configsOutDir("/tmp/dist"), "/tmp/dist/claude/configs");
});

test("claudeVendor.marketplaceManifestPath is claude/.claude-plugin/marketplace.json", () => {
  assert.equal(claudeVendor.marketplaceManifestPath, "claude/.claude-plugin/marketplace.json");
});

test("claudeVendor.emitMarketplaceManifest writes per-vendor manifest with relative sources rewritten to ./<plugin>", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "harness-kit-claude-emit-"));
  try {
    const marketplace: Marketplace = {
      name: "shop",
      owner: { name: "Acme" },
      metadata: { pluginRoot: "plugins" },
      plugins: [
        { name: "alpha", source: { kind: "relative", path: "./plugins/alpha" } },
        { name: "beta", source: { kind: "relative", path: "./plugins/beta" } },
        {
          name: "gh",
          source: { kind: "github", source: "github", repo: "acme/gh" },
        },
      ],
    };
    await claudeVendor.emitMarketplaceManifest({ outRoot: sandbox, marketplace });
    const target = join(sandbox, "claude/.claude-plugin/marketplace.json");
    const parsed = JSON.parse(readFileSync(target, "utf8")) as {
      name: string;
      metadata?: { pluginRoot?: string };
      plugins: ReadonlyArray<{ name: string; source: unknown }>;
    };
    assert.equal(parsed.name, "shop");
    assert.equal(parsed.metadata?.pluginRoot, undefined);
    assert.deepEqual(parsed.plugins[0], { name: "alpha", source: "./plugins/alpha" });
    assert.deepEqual(parsed.plugins[1], { name: "beta", source: "./plugins/beta" });
    assert.deepEqual(parsed.plugins[2], {
      name: "gh",
      source: { source: "github", repo: "acme/gh" },
    });
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
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

test("claudeVendor.install in remote mode uninstalls + installs each plugin via claude CLI", async () => {
  const { run, calls } = recordingRunner();
  await claudeVendor.install(
    ctx({
      run,
      mode: "remote",
      plugins: [
        { name: "alpha", path: "/tmp/dist/claude/alpha", version: "1.0.0" },
        { name: "beta", path: "/tmp/dist/claude/beta", version: "0.2.0" },
      ],
    }),
  );
  const cmds = calls.map((c) => [c.cmd, ...c.args].join(" "));
  assert.deepEqual(cmds, [
    "claude plugin uninstall alpha@test-market",
    "claude plugin uninstall beta@test-market",
    "claude plugin marketplace update test-market",
    "claude plugin install alpha@test-market",
    "claude plugin install beta@test-market",
  ]);
});

test("claudeVendor.install in local mode adds the dist marketplace instead of updating", async () => {
  const { run, calls } = recordingRunner();
  await claudeVendor.install(
    ctx({
      run,
      mode: "local",
      distRoot: "/tmp/dist",
      plugins: [{ name: "alpha", path: "/tmp/dist/claude/alpha", version: "1.0.0" }],
    }),
  );
  const cmds = calls.map((c) => [c.cmd, ...c.args].join(" "));
  assert.deepEqual(cmds, [
    "claude plugin uninstall alpha@test-market",
    "claude plugin marketplace add /tmp/dist/claude --scope local",
    "claude plugin install alpha@test-market",
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

test("readEnabledPlugins returns empty map when settings.json is missing", () => {
  const map = readEnabledPlugins(join(tmpdir(), "harness-kit-no-such-dir"));
  assert.equal(map.size, 0);
});

test("readEnabledPlugins throws on malformed JSON", () => {
  const dist = mkdtempSync(join(tmpdir(), "harness-kit-bad-json-"));
  try {
    const configsDir = join(dist, "claude/configs");
    mkdirSync(configsDir, { recursive: true });
    writeFileSync(join(configsDir, "settings.json"), "{ not json");
    assert.throws(() => readEnabledPlugins(configsDir), /settings\.json/);
  } finally {
    rmSync(dist, { recursive: true, force: true });
  }
});

test("readEnabledPlugins maps explicit true and false, omitting absent keys", () => {
  const dist = distWithSettings({ "on@m": true, "off@m": false });
  try {
    const map = readEnabledPlugins(join(dist, "claude/configs"));
    assert.equal(map.get("on@m"), true);
    assert.equal(map.get("off@m"), false);
    assert.equal(map.has("absent@m"), false);
  } finally {
    rmSync(dist, { recursive: true, force: true });
  }
});

test("readEnabledPlugins returns empty map when enabledPlugins is absent or non-object", () => {
  for (const value of [undefined, "nope", 42, null, []]) {
    const dist = distWithSettings(value);
    try {
      assert.equal(readEnabledPlugins(join(dist, "claude/configs")).size, 0);
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
  }
});

test("claudeVendor.install skips plugins explicitly disabled in settings", async () => {
  const dist = distWithSettings({ "beta@test-market": false });
  try {
    const { run, calls } = recordingRunner();
    await claudeVendor.install(
      ctx({
        run,
        mode: "remote",
        distRoot: dist,
        plugins: [
          { name: "alpha", path: join(dist, "claude/alpha"), version: "1.0.0" },
          { name: "beta", path: join(dist, "claude/beta"), version: "0.2.0" },
        ],
      }),
    );
    const cmds = calls.map((c) => [c.cmd, ...c.args].join(" "));
    assert.ok(cmds.includes("claude plugin install alpha@test-market"));
    assert.ok(!cmds.includes("claude plugin install beta@test-market"));
    assert.ok(cmds.includes("claude plugin marketplace update test-market"));
  } finally {
    rmSync(dist, { recursive: true, force: true });
  }
});

test("claudeVendor.install enables plugins absent from settings (absent = enabled)", async () => {
  const dist = distWithSettings({});
  try {
    const { run, calls } = recordingRunner();
    await claudeVendor.install(
      ctx({
        run,
        mode: "remote",
        distRoot: dist,
        plugins: [{ name: "alpha", path: join(dist, "claude/alpha"), version: "1.0.0" }],
      }),
    );
    const cmds = calls.map((c) => [c.cmd, ...c.args].join(" "));
    assert.ok(cmds.includes("claude plugin install alpha@test-market"));
  } finally {
    rmSync(dist, { recursive: true, force: true });
  }
});

test("claudeVendor.install installs none when all plugins are disabled, still refreshing marketplace", async () => {
  const dist = distWithSettings({
    "dev-tools@test-market": false,
    "brand@test-market": false,
  });
  try {
    const { run, calls } = recordingRunner();
    await claudeVendor.install(
      ctx({
        run,
        mode: "local",
        distRoot: dist,
        plugins: [
          { name: "dev-tools", path: join(dist, "claude/dev-tools"), version: "2.4.0" },
          { name: "brand", path: join(dist, "claude/brand"), version: "0.1.1" },
        ],
      }),
    );
    const cmds = calls.map((c) => [c.cmd, ...c.args].join(" "));
    assert.ok(!cmds.some((c) => c.startsWith("claude plugin install ")));
    assert.ok(cmds.includes(`claude plugin marketplace add ${join(dist, "claude")} --scope local`));
  } finally {
    rmSync(dist, { recursive: true, force: true });
  }
});

test("claudeVendor.partitionPlugins splits discovered plugins by enabled state", () => {
  const dist = distWithSettings({ "off@test-market": false });
  try {
    const result = claudeVendor.partitionPlugins?.(
      ctx({
        distRoot: dist,
        plugins: [
          { name: "on", path: join(dist, "claude/on"), version: "1.0.0" },
          { name: "off", path: join(dist, "claude/off"), version: "1.0.0" },
        ],
      }),
    );
    assert.deepEqual(
      result?.enabled.map((p) => p.name),
      ["on"],
    );
    assert.deepEqual(
      result?.disabled.map((p) => p.name),
      ["off"],
    );
  } finally {
    rmSync(dist, { recursive: true, force: true });
  }
});
