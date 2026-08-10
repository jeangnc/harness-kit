import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { claudeVendor, makeClaudeVendor, readDisabledPluginKeys, stageIntoPlace } from "./index.js";
import { discoverInstalled } from "../../installed.js";
import type { CommandRunner } from "../../install/runner.js";
import type { Marketplace } from "../../marketplace/index.js";
import type { VendorInstallContext } from "../../vendor/schema.js";

async function withSettings<T>(
  enabledPlugins: unknown,
  fn: (dist: string, home: string) => T | Promise<T>,
): Promise<T> {
  const sandbox = mkdtempSync(join(tmpdir(), "harness-kit-claude-settings-"));
  const dist = join(sandbox, "dist");
  const configsDir = join(dist, "claude/configs");
  mkdirSync(configsDir, { recursive: true });
  const body = enabledPlugins === undefined ? {} : { enabledPlugins };
  writeFileSync(join(configsDir, "settings.json"), JSON.stringify(body));
  try {
    return await fn(dist, join(sandbox, "home"));
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

interface Call {
  readonly cmd: string;
  readonly args: readonly string[];
}

function recordingRunner(home?: string): { run: CommandRunner; calls: Call[] } {
  const calls: Call[] = [];
  const run: CommandRunner = async (cmd, args) => {
    calls.push({ cmd, args });
    if (home !== undefined && args[0] === "plugin" && args[1] === "install") {
      registerPlugin(home, args[2]!);
    }
  };
  return { run, calls };
}

function registerPlugin(home: string, key: string): void {
  const registryFile = join(home, "plugins/installed_plugins.json");
  const registry: { version: number; plugins: Record<string, unknown> } = existsSync(registryFile)
    ? (JSON.parse(readFileSync(registryFile, "utf8")) as {
        version: number;
        plugins: Record<string, unknown>;
      })
    : { version: 2, plugins: {} };
  const [name, marketplace] = key.split("@");
  registry.plugins[key] = [
    {
      scope: "user",
      installPath: join(home, "plugins/cache", marketplace!, name!, "0.0.0"),
      version: "0.0.0",
    },
  ];
  mkdirSync(dirname(registryFile), { recursive: true });
  writeFileSync(registryFile, JSON.stringify(registry));
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

test("claudeVendor.install in remote mode installs each unregistered plugin without uninstalling", async () => {
  await withHome(async (home, dist) => {
    const alpha = writeDistPlugin(dist, "alpha", "1.0.0", "alpha-v1");
    const beta = writeDistPlugin(dist, "beta", "0.2.0", "beta-v0");
    const { run, calls } = recordingRunner(home);
    await makeClaudeVendor(home).install(
      ctx({
        run,
        mode: "remote",
        distRoot: dist,
        plugins: [
          { name: "alpha", path: alpha, version: "1.0.0" },
          { name: "beta", path: beta, version: "0.2.0" },
        ],
      }),
    );
    const cmds = calls.map((c) => [c.cmd, ...c.args].join(" "));
    assert.deepEqual(cmds, [
      "claude plugin marketplace update test-market",
      "claude plugin install alpha@test-market",
      "claude plugin install beta@test-market",
    ]);
  });
});

test("claudeVendor.install in local mode adds the dist marketplace instead of updating", async () => {
  await withHome(async (home, dist) => {
    const path = writeDistPlugin(dist, "alpha", "1.0.0", "alpha-v1");
    const { run, calls } = recordingRunner(home);
    await makeClaudeVendor(home).install(
      ctx({
        run,
        mode: "local",
        distRoot: dist,
        plugins: [{ name: "alpha", path, version: "1.0.0" }],
      }),
    );
    const cmds = calls.map((c) => [c.cmd, ...c.args].join(" "));
    assert.deepEqual(cmds, [
      `claude plugin marketplace add ${join(dist, "claude")} --scope local`,
      "claude plugin install alpha@test-market",
    ]);
  });
});

test("claudeVendor.install never uninstalls an already-registered plugin", async () => {
  await withHome(async (home, dist) => {
    const path = writeDistPlugin(dist, "alpha", "2.0.0", "alpha-v2");
    const existing = join(home, "plugins/cache/test-market/alpha/1.0.0");
    mkdirSync(existing, { recursive: true });
    writeFileSync(join(existing, "marker.txt"), "alpha-v1");
    writeInstalledRegistry(home, {
      version: 2,
      plugins: {
        "alpha@test-market": [{ scope: "user", installPath: existing, version: "1.0.0" }],
      },
    });
    const { run, calls } = recordingRunner();
    await makeClaudeVendor(home).install(
      ctx({ run, distRoot: dist, plugins: [{ name: "alpha", path, version: "2.0.0" }] }),
    );
    const cmds = calls.map((c) => [c.cmd, ...c.args].join(" "));
    assert.ok(
      !cmds.some((c) => c.startsWith("claude plugin uninstall")),
      "an installed plugin is refreshed in place, never uninstalled",
    );
    assert.ok(
      !cmds.includes("claude plugin install alpha@test-market"),
      "no reinstall needed for an already-registered plugin",
    );
    const entry = readRegistry(home).plugins["alpha@test-market"]![0]!;
    assert.equal(entry["version"], "2.0.0");
    assert.equal(entry["installPath"], join(home, "plugins/cache/test-market/alpha/2.0.0"));
    assert.equal(
      readFileSync(join(home, "plugins/cache/test-market/alpha/2.0.0/marker.txt"), "utf8"),
      "alpha-v2",
    );
  });
});

test("claudeVendor.install fails loudly when the CLI install does not register the plugin", async () => {
  await withHome(async (home, dist) => {
    const path = writeDistPlugin(dist, "alpha", "2.0.0", "alpha-v2");
    writeInstalledRegistry(home, { version: 2, plugins: {} });
    const run: CommandRunner = async (_cmd, args) => {
      if (args[1] === "marketplace") throw new Error("network down");
    };
    await assert.rejects(
      makeClaudeVendor(home).install(
        ctx({ run, distRoot: dist, plugins: [{ name: "alpha", path, version: "2.0.0" }] }),
      ),
      /did not register the plugin/,
      "a swallowed marketplace failure must not silently yield an unregistered plugin",
    );
  });
});

test("claudeVendor.install populates the cache for a newly registered plugin", async () => {
  await withHome(async (home, dist) => {
    const path = writeDistPlugin(dist, "alpha", "2.0.0", "alpha-v2");
    writeInstalledRegistry(home, { version: 2, plugins: {} });
    const dest = join(home, "plugins/cache/test-market/alpha/2.0.0");
    const run: CommandRunner = async (_cmd, args) => {
      if (args[1] !== "install") return;
      writeInstalledRegistry(home, {
        version: 2,
        plugins: {
          "alpha@test-market": [{ scope: "user", installPath: dest, version: "2.0.0" }],
        },
      });
    };
    await makeClaudeVendor(home).install(
      ctx({ run, distRoot: dist, plugins: [{ name: "alpha", path, version: "2.0.0" }] }),
    );
    assert.equal(
      readFileSync(join(dest, "marker.txt"), "utf8"),
      "alpha-v2",
      "registry entry resolves to a populated cache dir, never a dangling path",
    );
  });
});

test("claudeVendor.install keeps the live plugin cache when staging the new copy fails", async () => {
  await withHome(async (home, dist) => {
    const live = join(home, "plugins/cache/test-market/alpha/1.0.0");
    mkdirSync(live, { recursive: true });
    writeFileSync(join(live, "marker.txt"), "alpha-v1");
    writeInstalledRegistry(home, {
      version: 2,
      plugins: {
        "alpha@test-market": [{ scope: "user", installPath: live, version: "1.0.0" }],
      },
    });
    const { run } = recordingRunner();
    await assert.rejects(
      makeClaudeVendor(home).install(
        ctx({
          run,
          distRoot: dist,
          plugins: [
            { name: "alpha", path: join(dist, "claude/plugins/missing"), version: "2.0.0" },
          ],
        }),
      ),
    );
    assert.equal(
      readFileSync(join(live, "marker.txt"), "utf8"),
      "alpha-v1",
      "the working install survives a failed refresh",
    );
  });
});

test("claudeVendor.install keeps the live plugin intact when the copy fails partway through", async () => {
  await withHome(async (home, dist) => {
    const path = writeDistPlugin(dist, "alpha", "1.0.0", "alpha-v1-rebuilt");
    const unreadable = join(path, "unreadable");
    mkdirSync(unreadable, { recursive: true });
    writeFileSync(join(unreadable, "payload.txt"), "secret");
    chmodSync(unreadable, 0o000);
    const live = join(home, "plugins/cache/test-market/alpha/1.0.0");
    mkdirSync(live, { recursive: true });
    writeFileSync(join(live, "marker.txt"), "alpha-v1");
    writeInstalledRegistry(home, {
      version: 2,
      plugins: {
        "alpha@test-market": [{ scope: "user", installPath: live, version: "1.0.0" }],
      },
    });
    try {
      const { run } = recordingRunner(home);
      await assert.rejects(
        makeClaudeVendor(home).install(
          ctx({ run, distRoot: dist, plugins: [{ name: "alpha", path, version: "1.0.0" }] }),
        ),
        /cannot copy plugin from/,
      );
    } finally {
      chmodSync(unreadable, 0o755);
    }
    assert.equal(
      readFileSync(join(live, "marker.txt"), "utf8"),
      "alpha-v1",
      "a copy that dies mid-flight never touches the live plugin",
    );
    assert.deepEqual(
      readdirSync(join(home, "plugins/.staging")),
      [],
      "the half-copied payload is cleaned up",
    );
  });
});

test("stageIntoPlace leaves the live plugin untouched when it cannot be displaced", async () => {
  await withHome(async (home, dist) => {
    const source = writeDistPlugin(dist, "alpha", "1.0.0", "alpha-v1-rebuilt");
    const parent = join(home, "plugins/cache/test-market/alpha");
    const live = join(parent, "1.0.0");
    mkdirSync(live, { recursive: true });
    writeFileSync(join(live, "marker.txt"), "alpha-v1");
    chmodSync(parent, 0o500);
    try {
      await assert.rejects(stageIntoPlace(home, source, live), /EACCES/);
    } finally {
      chmodSync(parent, 0o755);
    }
    assert.equal(
      readFileSync(join(live, "marker.txt"), "utf8"),
      "alpha-v1",
      "a plugin that cannot be displaced is never removed",
    );
    assert.deepEqual(
      readdirSync(join(home, "plugins/.staging")),
      [],
      "a failure that displaces nothing leaves no staging debris to accumulate",
    );
  });
});

test("claudeVendor.install keeps the live plugin when the incoming copy cannot be staged", async () => {
  await withHome(async (home, dist) => {
    const live = join(home, "plugins/cache/test-market/alpha/1.0.0");
    mkdirSync(live, { recursive: true });
    writeFileSync(join(live, "marker.txt"), "alpha-v1");
    writeInstalledRegistry(home, {
      version: 2,
      plugins: {
        "alpha@test-market": [{ scope: "user", installPath: live, version: "1.0.0" }],
      },
    });
    const { run } = recordingRunner(home);
    await assert.rejects(
      makeClaudeVendor(home).install(
        ctx({
          run,
          distRoot: dist,
          plugins: [{ name: "alpha", path: join(dist, "claude/plugins/absent"), version: "1.0.0" }],
        }),
      ),
    );
    assert.equal(
      readFileSync(join(live, "marker.txt"), "utf8"),
      "alpha-v1",
      "a failed copy never displaces the working install",
    );
    assert.deepEqual(
      readdirSync(join(home, "plugins/.staging")),
      [],
      "failed staging leaves no debris behind",
    );
  });
});

test("claudeVendor.install spares a version dir another registry entry still points at", async () => {
  await withHome(async (home, dist) => {
    const path = writeDistPlugin(dist, "alpha", "2.0.0", "alpha-v2");
    const shared = join(home, "plugins/cache/test-market/alpha/1.0.0");
    mkdirSync(shared, { recursive: true });
    writeFileSync(join(shared, "marker.txt"), "alpha-v1");
    writeInstalledRegistry(home, {
      version: 2,
      plugins: {
        "alpha@test-market": [{ scope: "user", installPath: shared, version: "1.0.0" }],
        "alpha-legacy@test-market": [{ scope: "user", installPath: shared, version: "1.0.0" }],
      },
    });
    const { run } = recordingRunner(home);
    await makeClaudeVendor(home).install(
      ctx({ run, distRoot: dist, plugins: [{ name: "alpha", path, version: "2.0.0" }] }),
    );
    assert.equal(
      readFileSync(join(shared, "marker.txt"), "utf8"),
      "alpha-v1",
      "pruning never deletes a dir another plugin key still depends on",
    );
    assert.equal(
      readRegistry(home).plugins["alpha-legacy@test-market"]![0]!["installPath"],
      shared,
      "the untouched key keeps pointing at a dir that still exists",
    );
  });
});

test("claudeVendor.install leaves no staging dirs inside the scanned cache tree", async () => {
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
    const vendor = makeClaudeVendor(home);
    await vendor.install(
      ctx({ run, distRoot: dist, plugins: [{ name: "alpha", path, version: "2.0.0" }] }),
    );
    const staged = await mkdtemp(join(home, "plugins/.staging/incoming-"));
    cpSync(path, join(staged, "payload"), { recursive: true });
    const found = await discoverInstalled([
      {
        name: "claude",
        root: join(home, "plugins/cache"),
        manifestRelativePath: vendor.pluginManifestPath,
      },
    ]);
    assert.deepEqual(
      found.skills.map((s) => s.plugin),
      ["alpha"],
      "a staging copy in flight is invisible to the scanner — no duplicate plugin",
    );
    assert.deepEqual(
      readdirSync(join(home, "plugins/cache/test-market/alpha")),
      ["2.0.0"],
      "only the real version dir remains — no staging sibling for the scanner to find",
    );
    assert.deepEqual(
      await vendor.installedVersions(ctx({ run, distRoot: dist })),
      new Map([["alpha", "2.0.0"]]),
      "installedVersions never reports a staging dir as a version",
    );
  });
});

test("claudeVendor.install prunes leaked temp_* staging dirs but spares real marketplaces", async () => {
  const home = mkdtempSync(join(tmpdir(), "harness-kit-claude-prune-"));
  try {
    const marketplaces = join(home, "plugins/marketplaces");
    for (const name of ["temp_111", "temp_222", "gq-marketplace", "claude-plugins-official"]) {
      mkdirSync(join(marketplaces, name), { recursive: true });
    }
    const dist = join(home, "dist");
    const path = writeDistPlugin(dist, "alpha", "1.0.0", "alpha-v1");
    const { run } = recordingRunner(home);
    const v = makeClaudeVendor(home);
    await v.install(
      ctx({
        run,
        mode: "local",
        distRoot: dist,
        plugins: [{ name: "alpha", path, version: "1.0.0" }],
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
  await withSettings({ "beta@test-market": false }, async (dist, home) => {
    const alpha = writeDistPlugin(dist, "alpha", "1.0.0", "alpha-v1");
    const { run, calls } = recordingRunner(home);
    await makeClaudeVendor(home).install(
      ctx({
        run,
        mode: "remote",
        distRoot: dist,
        plugins: [
          { name: "alpha", path: alpha, version: "1.0.0" },
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
  await withSettings({}, async (dist, home) => {
    const alpha = writeDistPlugin(dist, "alpha", "1.0.0", "alpha-v1");
    const { run, calls } = recordingRunner(home);
    await makeClaudeVendor(home).install(
      ctx({
        run,
        mode: "remote",
        distRoot: dist,
        plugins: [{ name: "alpha", path: alpha, version: "1.0.0" }],
      }),
    );
    const cmds = calls.map((c) => [c.cmd, ...c.args].join(" "));
    assert.ok(cmds.includes("claude plugin install alpha@test-market"));
  });
});

test("claudeVendor.install installs none when all plugins are disabled, still refreshing marketplace", async () => {
  await withSettings(
    { "dev-tools@test-market": false, "brand@test-market": false },
    async (dist, home) => {
      const { run, calls } = recordingRunner(home);
      await makeClaudeVendor(home).install(
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
  mkdirSync(join(dir, "skills", name), { recursive: true });
  writeFileSync(join(dir, "skills", name, "SKILL.md"), `# ${name}\n`);
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

test("claudeVendor.install reads disabled state before any command mutates settings.json", async () => {
  await withSettings({ "beta@test-market": false }, async (dist, home) => {
    const alpha = writeDistPlugin(dist, "alpha", "1.0.0", "alpha-v1");
    const settingsPath = join(dist, "claude/configs/settings.json");
    const calls: string[] = [];
    await makeClaudeVendor(home).install(
      ctx({
        run: async (cmd, args) => {
          calls.push([cmd, ...args].join(" "));
          writeFileSync(settingsPath, JSON.stringify({ enabledPlugins: {} }));
          if (args[1] === "install") registerPlugin(home, args[2]!);
        },
        mode: "remote",
        distRoot: dist,
        plugins: [
          { name: "alpha", path: alpha, version: "1.0.0" },
          { name: "beta", path: join(dist, "claude/beta"), version: "0.2.0" },
        ],
      }),
    );
    assert.ok(calls.includes("claude plugin install alpha@test-market"));
    assert.ok(
      !calls.includes("claude plugin install beta@test-market"),
      "a mid-run settings rewrite must not resurrect a disabled plugin",
    );
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

function seedInstalled(
  home: string,
  marketplace: string,
  name: string,
  version: string,
  options: { keepExisting?: boolean } = {},
): void {
  const cached = join(home, "plugins/cache", marketplace, name, version, ".claude-plugin");
  mkdirSync(cached, { recursive: true });
  writeFileSync(join(cached, "plugin.json"), JSON.stringify({ name, version }));
  const registryDir = join(home, "plugins");
  mkdirSync(registryDir, { recursive: true });
  const registryPath = join(registryDir, "installed_plugins.json");
  const existing =
    options.keepExisting === true
      ? (JSON.parse(readFileSync(registryPath, "utf8")) as { plugins: Record<string, unknown> })
          .plugins
      : {};
  const installPath = join(home, "plugins/cache", marketplace, name, version);
  writeFileSync(
    registryPath,
    JSON.stringify({
      version: 2,
      plugins: {
        ...existing,
        [`${name}@${marketplace}`]: [
          { scope: "user", installPath, version },
          { scope: "local", projectPath: "/repo", installPath, version },
        ],
      },
    }),
  );
}

test("claudeVendor.pruneStale removes the cache dir and every registry scope entry", async () => {
  const home = mkdtempSync(join(tmpdir(), "harness-kit-claude-prunestale-"));
  try {
    seedInstalled(home, "test-market", "legacy", "0.9.0");
    const vendor = makeClaudeVendor(home);
    const { run, calls } = recordingRunner();

    await vendor.pruneStale(ctx({ run, marketplace: "test-market" }), ["legacy"]);

    assert.equal(
      existsSync(join(home, "plugins/cache/test-market/legacy")),
      false,
      "the cache dir is gone",
    );
    const registry = JSON.parse(
      readFileSync(join(home, "plugins/installed_plugins.json"), "utf8"),
    ) as { plugins: Record<string, unknown> };
    assert.deepEqual(Object.keys(registry.plugins), [], "every scope entry is gone");
    assert.deepEqual(calls[0], {
      cmd: "claude",
      args: ["plugin", "uninstall", "legacy@test-market"],
    });
    assert.deepEqual(
      await vendor.installedVersions(ctx({ run, marketplace: "test-market" })),
      new Map(),
      "the pruned plugin can never be reported again",
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("claudeVendor.pruneStale spares a plugin it was not asked to remove", async () => {
  const home = mkdtempSync(join(tmpdir(), "harness-kit-claude-prunespare-"));
  try {
    seedInstalled(home, "test-market", "keeper", "1.0.0");
    const vendor = makeClaudeVendor(home);
    const { run } = recordingRunner();

    await vendor.pruneStale(ctx({ run, marketplace: "test-market" }), []);

    assert.deepEqual(
      await vendor.installedVersions(ctx({ run, marketplace: "test-market" })),
      new Map([["keeper", "1.0.0"]]),
      "an empty stale set removes nothing",
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("claudeVendor.pruneStale leaves no plugin half-removed when a later removal fails", async () => {
  const home = mkdtempSync(join(tmpdir(), "harness-kit-claude-pruneorder-"));
  try {
    seedInstalled(home, "test-market", "first", "0.9.0");
    seedInstalled(home, "test-market", "second", "0.8.0", { keepExisting: true });
    const vendor = makeClaudeVendor(home);
    const { run } = recordingRunner();
    const corruptRegistryAfterFirst: CommandRunner = async (cmd, args) => {
      await run(cmd, args);
      if (args.includes("second@test-market")) {
        writeFileSync(join(home, "plugins/installed_plugins.json"), "{ not json");
      }
    };

    await assert.rejects(
      async () =>
        vendor.pruneStale(ctx({ run: corruptRegistryAfterFirst, marketplace: "test-market" }), [
          "first",
          "second",
        ]),
      "the failure surfaces rather than passing silently",
    );

    assert.deepEqual(
      await vendor.installedVersions(ctx({ marketplace: "test-market" })),
      new Map([["second", "0.8.0"]]),
      "the failed plugin keeps its cache dir, so the next update still reports it",
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
