import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { claudeVendor, makeClaudeVendor, readDisabledPluginKeys } from "./index.js";
import type { CommandRunner } from "../../install/runner.js";
import type { Marketplace } from "../../marketplace/index.js";
import type { VendorInstallContext } from "../../vendor/schema.js";

async function withSettings<T>(
  enabledPlugins: unknown,
  fn: (dist: string) => T | Promise<T>,
): Promise<T> {
  const dist = mkdtempSync(join(tmpdir(), "harness-kit-claude-settings-"));
  const configsDir = join(dist, "claude/configs");
  mkdirSync(configsDir, { recursive: true });
  const body = enabledPlugins === undefined ? {} : { enabledPlugins };
  writeFileSync(join(configsDir, "settings.json"), JSON.stringify(body));
  try {
    return await fn(dist);
  } finally {
    rmSync(dist, { recursive: true, force: true });
  }
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

test("claudeVendor.install prunes leaked temp_* staging dirs but spares real marketplaces", async () => {
  const home = mkdtempSync(join(tmpdir(), "harness-kit-claude-prune-"));
  try {
    const marketplaces = join(home, "plugins/marketplaces");
    for (const name of ["temp_111", "temp_222", "gq-marketplace", "claude-plugins-official"]) {
      mkdirSync(join(marketplaces, name), { recursive: true });
    }
    const { run } = recordingRunner();
    const v = makeClaudeVendor(home);
    await v.install(
      ctx({
        run,
        mode: "local",
        distRoot: join(home, "dist"),
        plugins: [{ name: "alpha", path: join(home, "dist/claude/alpha"), version: "1.0.0" }],
      }),
    );
    assert.deepEqual(readdirSync(marketplaces).sort(), [
      "claude-plugins-official",
      "gq-marketplace",
    ]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
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

test("readDisabledPluginKeys returns empty set when settings.json is missing", () => {
  const keys = readDisabledPluginKeys(join(tmpdir(), "harness-kit-no-such-dir"));
  assert.equal(keys.size, 0);
});

test("claudeVendor.isInstalled is true when a plugin cache exists for the marketplace", async () => {
  const home = mkdtempSync(join(tmpdir(), "harness-kit-claude-home-"));
  try {
    mkdirSync(join(home, "plugins/cache/shop/alpha"), { recursive: true });
    const v = makeClaudeVendor(home);
    assert.equal(await v.isInstalled(ctx({ marketplace: "shop" })), true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("claudeVendor.isInstalled is false when the plugin cache is empty", async () => {
  const home = mkdtempSync(join(tmpdir(), "harness-kit-claude-home-"));
  try {
    const v = makeClaudeVendor(home);
    assert.equal(await v.isInstalled(ctx({ marketplace: "shop", distRoot: home })), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("claudeVendor.isInstalled is false when only config links exist but no plugin is cached", async () => {
  const home = mkdtempSync(join(tmpdir(), "harness-kit-claude-home-"));
  try {
    writeFileSync(join(home, "settings.json"), "{}");
    const v = makeClaudeVendor(home);
    assert.equal(await v.isInstalled(ctx({ marketplace: "shop", distRoot: home })), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("claudeVendor.installedVersions reads each cached plugin's manifest version", async () => {
  const home = mkdtempSync(join(tmpdir(), "harness-kit-claude-home-"));
  try {
    const manifestDir = join(home, "plugins/cache/shop/alpha/1.2.3/.claude-plugin");
    mkdirSync(manifestDir, { recursive: true });
    writeFileSync(
      join(manifestDir, "plugin.json"),
      JSON.stringify({ name: "alpha", version: "1.2.3" }),
    );
    const v = makeClaudeVendor(home);
    const versions = await v.installedVersions(ctx({ marketplace: "shop" }));
    assert.equal(versions.get("alpha"), "1.2.3");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("claudeVendor.installedVersions omits a plugin whose manifest is unreadable", async () => {
  const home = mkdtempSync(join(tmpdir(), "harness-kit-claude-home-"));
  try {
    mkdirSync(join(home, "plugins/cache/shop/broken"), { recursive: true });
    const v = makeClaudeVendor(home);
    const versions = await v.installedVersions(ctx({ marketplace: "shop" }));
    assert.equal(versions.has("broken"), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("claudeVendor.installedVersions deterministically picks the latest when several version dirs coexist", async () => {
  const home = mkdtempSync(join(tmpdir(), "harness-kit-claude-home-"));
  try {
    for (const version of ["9.0.0", "10.0.0", "9.5.0"]) {
      const dir = join(home, "plugins/cache/shop/alpha", version, ".claude-plugin");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "plugin.json"), JSON.stringify({ name: "alpha", version }));
    }
    const v = makeClaudeVendor(home);
    const versions = await v.installedVersions(ctx({ marketplace: "shop" }));
    assert.equal(versions.get("alpha"), "10.0.0");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("readDisabledPluginKeys throws on malformed JSON", () => {
  const dist = mkdtempSync(join(tmpdir(), "harness-kit-bad-json-"));
  try {
    const configsDir = join(dist, "claude/configs");
    mkdirSync(configsDir, { recursive: true });
    writeFileSync(join(configsDir, "settings.json"), "{ not json");
    assert.throws(() => readDisabledPluginKeys(configsDir), /settings\.json/);
  } finally {
    rmSync(dist, { recursive: true, force: true });
  }
});

test("readDisabledPluginKeys collects only explicitly-false keys, omitting true and absent", async () => {
  await withSettings({ "on@m": true, "off@m": false }, (dist) => {
    const keys = readDisabledPluginKeys(join(dist, "claude/configs"));
    assert.deepEqual([...keys], ["off@m"]);
  });
});

test("readDisabledPluginKeys returns empty set when enabledPlugins is absent", async () => {
  await withSettings(undefined, (dist) => {
    assert.equal(readDisabledPluginKeys(join(dist, "claude/configs")).size, 0);
  });
});

test("readDisabledPluginKeys throws when enabledPlugins is present but not an object", async () => {
  for (const value of ["nope", 42, null, []]) {
    await withSettings(value, (dist) => {
      assert.throws(() => readDisabledPluginKeys(join(dist, "claude/configs")), /enabledPlugins/);
    });
  }
});

test("readDisabledPluginKeys throws when an entry value is not a boolean (no silent typo)", async () => {
  await withSettings({ "off@m": "false" }, (dist) => {
    assert.throws(() => readDisabledPluginKeys(join(dist, "claude/configs")), /must be a boolean/);
  });
});

test("claudeVendor.install skips plugins explicitly disabled in settings", async () => {
  await withSettings({ "beta@test-market": false }, async (dist) => {
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
  });
});

test("claudeVendor.install enables plugins absent from settings (absent = enabled)", async () => {
  await withSettings({}, async (dist) => {
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
  });
});

test("claudeVendor.install installs none when all plugins are disabled, still refreshing marketplace", async () => {
  await withSettings(
    { "dev-tools@test-market": false, "brand@test-market": false },
    async (dist) => {
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
      assert.ok(
        cmds.includes(`claude plugin marketplace add ${join(dist, "claude")} --scope local`),
      );
    },
  );
});

async function withHome<T>(fn: (home: string, dist: string) => Promise<T>): Promise<T> {
  const sandbox = mkdtempSync(join(tmpdir(), "harness-kit-claude-refresh-"));
  try {
    return await fn(join(sandbox, "home"), join(sandbox, "dist"));
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

function writeDistPlugin(dist: string, name: string, version: string, markerBody: string): string {
  const dir = join(dist, "claude/plugins", name);
  mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
  writeFileSync(join(dir, ".claude-plugin/plugin.json"), JSON.stringify({ name, version }));
  writeFileSync(join(dir, "marker.txt"), markerBody);
  return dir;
}

function writeInstalledRegistry(home: string, body: unknown): void {
  mkdirSync(join(home, "plugins"), { recursive: true });
  writeFileSync(join(home, "plugins/installed_plugins.json"), JSON.stringify(body));
}

function readRegistry(home: string): {
  plugins: Record<string, ReadonlyArray<Record<string, unknown>>>;
} {
  return JSON.parse(readFileSync(join(home, "plugins/installed_plugins.json"), "utf8")) as {
    plugins: Record<string, ReadonlyArray<Record<string, unknown>>>;
  };
}

test("claudeVendor.refresh copies the shipped plugin into the versioned cache dir", async () => {
  await withHome(async (home, dist) => {
    const path = writeDistPlugin(dist, "alpha", "2.0.0", "alpha-v2");
    writeInstalledRegistry(home, {
      version: 2,
      plugins: {
        "alpha@test-market": [
          {
            scope: "user",
            installPath: join(home, "plugins/cache/test-market/alpha/1.0.0"),
            version: "1.0.0",
          },
        ],
      },
    });
    const { run } = recordingRunner();
    await makeClaudeVendor(home).refresh(
      ctx({ run, distRoot: dist, plugins: [{ name: "alpha", path, version: "2.0.0" }] }),
    );
    const cached = join(home, "plugins/cache/test-market/alpha/2.0.0/marker.txt");
    assert.equal(readFileSync(cached, "utf8"), "alpha-v2");
  });
});

test("claudeVendor.refresh patches the registry version and installPath across all scopes", async () => {
  await withHome(async (home, dist) => {
    const path = writeDistPlugin(dist, "alpha", "2.0.0", "alpha-v2");
    writeInstalledRegistry(home, {
      version: 2,
      plugins: {
        "alpha@test-market": [
          {
            scope: "user",
            installPath: join(home, "plugins/cache/test-market/alpha/1.0.0"),
            version: "1.0.0",
          },
          {
            scope: "local",
            projectPath: "/repo",
            installPath: join(home, "plugins/cache/test-market/alpha/1.0.0"),
            version: "1.0.0",
          },
        ],
      },
    });
    const { run } = recordingRunner();
    await makeClaudeVendor(home).refresh(
      ctx({ run, distRoot: dist, plugins: [{ name: "alpha", path, version: "2.0.0" }] }),
    );
    const entries = readRegistry(home).plugins["alpha@test-market"]!;
    const expectedPath = join(home, "plugins/cache/test-market/alpha/2.0.0");
    assert.equal(entries.length, 2);
    for (const entry of entries) {
      assert.equal(entry["version"], "2.0.0");
      assert.equal(entry["installPath"], expectedPath);
      assert.match(
        String(entry["lastUpdated"]),
        /^\d{4}-\d{2}-\d{2}T/,
        "lastUpdated set to an ISO timestamp",
      );
    }
    assert.equal(entries[1]!["projectPath"], "/repo", "scope metadata preserved");
  });
});

test("claudeVendor.refresh skips a plugin absent from the install registry (never registers something new)", async () => {
  await withHome(async (home, dist) => {
    const path = writeDistPlugin(dist, "ghost", "1.0.0", "ghost");
    writeInstalledRegistry(home, { version: 2, plugins: {} });
    const { run } = recordingRunner();
    await makeClaudeVendor(home).refresh(
      ctx({ run, distRoot: dist, plugins: [{ name: "ghost", path, version: "1.0.0" }] }),
    );
    assert.deepEqual(readRegistry(home).plugins, {}, "unregistered plugin stays unregistered");
    assert.equal(
      existsSync(join(home, "plugins/cache/test-market/ghost")),
      false,
      "no cache is written for an unregistered plugin",
    );
  });
});

test("claudeVendor.refresh never writes settings.json", async () => {
  await withHome(async (home, dist) => {
    const path = writeDistPlugin(dist, "alpha", "2.0.0", "alpha-v2");
    mkdirSync(home, { recursive: true });
    const settingsPath = join(home, "settings.json");
    writeFileSync(settingsPath, JSON.stringify({ enabledPlugins: { "alpha@test-market": true } }));
    const before = readFileSync(settingsPath, "utf8");
    writeInstalledRegistry(home, {
      version: 2,
      plugins: {
        "alpha@test-market": [
          {
            scope: "user",
            installPath: join(home, "plugins/cache/test-market/alpha/1.0.0"),
            version: "1.0.0",
          },
        ],
      },
    });
    const { run, calls } = recordingRunner();
    await makeClaudeVendor(home).refresh(
      ctx({ run, distRoot: dist, plugins: [{ name: "alpha", path, version: "2.0.0" }] }),
    );
    assert.equal(readFileSync(settingsPath, "utf8"), before, "settings.json byte-unchanged");
    assert.equal(calls.length, 0, "refresh runs no claude CLI command");
  });
});

test("claudeVendor.refresh removes the stale prior-version cache dir", async () => {
  await withHome(async (home, dist) => {
    const path = writeDistPlugin(dist, "alpha", "2.0.0", "alpha-v2");
    const stale = join(home, "plugins/cache/test-market/alpha/1.0.0");
    mkdirSync(stale, { recursive: true });
    writeFileSync(join(stale, "marker.txt"), "alpha-v1");
    writeInstalledRegistry(home, {
      version: 2,
      plugins: {
        "alpha@test-market": [{ scope: "user", installPath: stale, version: "1.0.0" }],
      },
    });
    const { run } = recordingRunner();
    await makeClaudeVendor(home).refresh(
      ctx({ run, distRoot: dist, plugins: [{ name: "alpha", path, version: "2.0.0" }] }),
    );
    assert.equal(existsSync(stale), false, "old version dir is pruned");
    assert.equal(
      readFileSync(join(home, "plugins/cache/test-market/alpha/2.0.0/marker.txt"), "utf8"),
      "alpha-v2",
    );
  });
});

test("claudeVendor.install still enables plugins absent from settings", async () => {
  await withSettings({}, async (dist) => {
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
  });
});

test("claudeVendor.install reads disabled state before uninstall mutates settings.json", async () => {
  await withSettings({ "beta@test-market": false }, async (dist) => {
    const settingsPath = join(dist, "claude/configs/settings.json");
    const run: CommandRunner = async (_cmd, args) => {
      if (args[0] === "plugin" && args[1] === "uninstall") {
        writeFileSync(settingsPath, JSON.stringify({ enabledPlugins: {} }));
      }
    };
    const calls: string[] = [];
    await claudeVendor.install(
      ctx({
        run: async (cmd, args) => {
          calls.push([cmd, ...args].join(" "));
          await run(cmd, args);
        },
        mode: "remote",
        distRoot: dist,
        plugins: [
          { name: "alpha", path: join(dist, "claude/alpha"), version: "1.0.0" },
          { name: "beta", path: join(dist, "claude/beta"), version: "0.2.0" },
        ],
      }),
    );
    assert.ok(calls.includes("claude plugin install alpha@test-market"));
    assert.ok(!calls.includes("claude plugin install beta@test-market"));
  });
});

test("claudeVendor.partitionPlugins splits discovered plugins by enabled state", async () => {
  await withSettings({ "off@test-market": false }, (dist) => {
    const result = claudeVendor.partitionPlugins(
      ctx({
        distRoot: dist,
        plugins: [
          { name: "on", path: join(dist, "claude/on"), version: "1.0.0" },
          { name: "off", path: join(dist, "claude/off"), version: "1.0.0" },
        ],
      }),
    );
    assert.deepEqual(
      result.enabled.map((p) => p.name),
      ["on"],
    );
    assert.deepEqual(
      result.disabled.map((p) => p.name),
      ["off"],
    );
  });
});

test("claudeVendor.partitionPlugins treats a plugin disabled under a different marketplace as enabled", async () => {
  await withSettings({ "alpha@other-market": false }, (dist) => {
    const result = claudeVendor.partitionPlugins(
      ctx({
        marketplace: "test-market",
        distRoot: dist,
        plugins: [{ name: "alpha", path: join(dist, "claude/alpha"), version: "1.0.0" }],
      }),
    );
    assert.deepEqual(
      result.enabled.map((p) => p.name),
      ["alpha"],
    );
    assert.equal(result.disabled.length, 0);
  });
});
