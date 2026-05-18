import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { installWithRunner, uninstallWithRunner } from "./index.js";
import type { CommandRunner } from "./runner.js";
import type { Vendor, VendorInstallContext } from "../vendor/schema.js";

interface CommandCall {
  readonly cmd: string;
  readonly args: readonly string[];
}

function recordingRunner(): { run: CommandRunner; calls: CommandCall[] } {
  const calls: CommandCall[] = [];
  return {
    calls,
    run: async (cmd, args) => {
      calls.push({ cmd, args });
    },
  };
}

interface VendorRecord {
  readonly installs: VendorInstallContext[];
  readonly uninstalls: VendorInstallContext[];
}

function makeRecordingVendor(
  name: string,
  home: string,
  record: VendorRecord,
  extra: Partial<Vendor> = {},
): Vendor {
  return {
    name,
    home,
    pluginManifestPath: `.${name}-plugin/plugin.json`,
    emitPluginManifest: async () => undefined,
    install: async (ctx) => {
      record.installs.push(ctx);
    },
    uninstall: async (ctx) => {
      record.uninstalls.push(ctx);
    },
    ...extra,
  };
}

interface FixtureOptions {
  readonly marketplaceName: string;
  readonly plugins: ReadonlyArray<{
    readonly name: string;
    readonly vendor: string;
    readonly version: string;
  }>;
}

async function withInstallFixture<T>(
  options: FixtureOptions,
  fn: (paths: { distRoot: string; sandbox: string }) => Promise<T>,
): Promise<T> {
  const sandbox = mkdtempSync(join(tmpdir(), "harness-kit-install-"));
  const distRoot = join(sandbox, "dist");
  mkdirSync(join(distRoot, ".claude-plugin"), { recursive: true });
  writeFileSync(
    join(distRoot, ".claude-plugin/marketplace.json"),
    JSON.stringify({ name: options.marketplaceName }),
  );
  for (const plugin of options.plugins) {
    const pluginPath = join(distRoot, "plugins", plugin.vendor, plugin.name);
    const manifestDir = join(pluginPath, `.${plugin.vendor}-plugin`);
    mkdirSync(manifestDir, { recursive: true });
    writeFileSync(
      join(manifestDir, "plugin.json"),
      JSON.stringify({ name: plugin.name, version: plugin.version }),
    );
  }
  return fn({ distRoot, sandbox }).finally(() => rmSync(sandbox, { recursive: true, force: true }));
}

test("install dispatches vendor.install with discovered per-vendor plugins", async () => {
  await withInstallFixture(
    {
      marketplaceName: "shop",
      plugins: [
        { name: "alpha", vendor: "claude", version: "1.0.0" },
        { name: "beta", vendor: "codex", version: "2.0.0" },
      ],
    },
    async ({ distRoot, sandbox }) => {
      const recorder = recordingRunner();
      const claudeRecord: VendorRecord = { installs: [], uninstalls: [] };
      const codexRecord: VendorRecord = { installs: [], uninstalls: [] };
      const claude = makeRecordingVendor("claude", join(sandbox, "claude"), claudeRecord);
      const codex = makeRecordingVendor("codex", join(sandbox, "codex"), codexRecord);

      await installWithRunner({ distRoot, vendors: [claude, codex], silent: true }, recorder.run);

      assert.equal(claudeRecord.installs.length, 1);
      assert.equal(codexRecord.installs.length, 1);
      assert.deepEqual(
        claudeRecord.installs[0]!.plugins.map((p) => p.name),
        ["alpha"],
      );
      assert.deepEqual(
        codexRecord.installs[0]!.plugins.map((p) => p.name),
        ["beta"],
      );
      assert.equal(claudeRecord.installs[0]!.marketplace, "shop");
      assert.equal(claudeRecord.installs[0]!.distRoot, distRoot);
    },
  );
});

test("install applies config links before invoking vendors", async () => {
  await withInstallFixture(
    {
      marketplaceName: "shop",
      plugins: [{ name: "alpha", vendor: "claude", version: "1.0.0" }],
    },
    async ({ distRoot, sandbox }) => {
      const repoRoot = sandbox;
      const srcDir = join(repoRoot, "src/configs/claude");
      mkdirSync(srcDir, { recursive: true });
      writeFileSync(join(srcDir, "settings.json"), "{}");
      writeFileSync(
        join(distRoot, "configs.json"),
        JSON.stringify({
          links: [
            {
              src: "configs/claude/settings.json",
              vendors: ["claude"],
              destRel: "settings.json",
              kind: "file",
            },
          ],
        }),
      );
      const recorder = recordingRunner();
      const claudeHome = join(sandbox, "claude");
      const claudeRecord: VendorRecord = { installs: [], uninstalls: [] };
      const claude = makeRecordingVendor("claude", claudeHome, claudeRecord);

      await installWithRunner(
        { distRoot, repoRoot, vendors: [claude], silent: true },
        recorder.run,
      );

      const linked = join(claudeHome, "settings.json");
      assert.ok(lstatSync(linked).isSymbolicLink(), "config link should have been applied");
    },
  );
});

test("install --dry-run reports plan without touching disk or invoking vendors", async () => {
  await withInstallFixture(
    {
      marketplaceName: "shop",
      plugins: [{ name: "alpha", vendor: "claude", version: "1.0.0" }],
    },
    async ({ distRoot, sandbox }) => {
      const repoRoot = sandbox;
      const srcDir = join(repoRoot, "src/configs/claude");
      mkdirSync(srcDir, { recursive: true });
      writeFileSync(join(srcDir, "settings.json"), "{}");
      writeFileSync(
        join(distRoot, "configs.json"),
        JSON.stringify({
          links: [
            {
              src: "configs/claude/settings.json",
              vendors: ["claude"],
              destRel: "settings.json",
              kind: "file",
            },
          ],
        }),
      );
      const recorder = recordingRunner();
      const claudeHome = join(sandbox, "claude");
      const claudeRecord: VendorRecord = { installs: [], uninstalls: [] };
      const claude = makeRecordingVendor("claude", claudeHome, claudeRecord);
      const logs: string[] = [];

      await installWithRunner(
        {
          distRoot,
          repoRoot,
          vendors: [claude],
          dryRun: true,
          silent: false,
          log: (m) => logs.push(m),
        },
        recorder.run,
      );

      assert.ok(!existsSync(join(claudeHome, "settings.json")), "dry run must not link");
      assert.equal(claudeRecord.installs.length, 0, "dry run must not invoke vendor.install");
      const joined = logs.join("\n");
      assert.match(joined, /settings\.json/);
      assert.match(joined, /alpha/);
    },
  );
});

test("uninstall dispatches vendor.uninstall with discovered plugins", async () => {
  await withInstallFixture(
    {
      marketplaceName: "shop",
      plugins: [{ name: "alpha", vendor: "claude", version: "1.0.0" }],
    },
    async ({ distRoot, sandbox }) => {
      const recorder = recordingRunner();
      const claudeRecord: VendorRecord = { installs: [], uninstalls: [] };
      const claude = makeRecordingVendor("claude", join(sandbox, "claude"), claudeRecord);

      await uninstallWithRunner({ distRoot, vendors: [claude], silent: true }, recorder.run);

      assert.equal(claudeRecord.uninstalls.length, 1);
      assert.deepEqual(
        claudeRecord.uninstalls[0]!.plugins.map((p) => p.name),
        ["alpha"],
      );
    },
  );
});

test("install rejects a marketplace.json missing the required `name` field", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "harness-kit-install-"));
  const distRoot = join(sandbox, "dist");
  mkdirSync(join(distRoot, ".claude-plugin"), { recursive: true });
  writeFileSync(join(distRoot, ".claude-plugin/marketplace.json"), JSON.stringify({}));
  mkdirSync(join(distRoot, "plugins/claude"), { recursive: true });
  try {
    const recorder = recordingRunner();
    const claudeRecord: VendorRecord = { installs: [], uninstalls: [] };
    const claude = makeRecordingVendor("claude", join(sandbox, "claude"), claudeRecord);
    await assert.rejects(
      installWithRunner({ distRoot, vendors: [claude], silent: true }, recorder.run),
      /name/i,
    );
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("install rejects a plugin.json missing the required `version` field", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "harness-kit-install-"));
  const distRoot = join(sandbox, "dist");
  mkdirSync(join(distRoot, ".claude-plugin"), { recursive: true });
  writeFileSync(
    join(distRoot, ".claude-plugin/marketplace.json"),
    JSON.stringify({ name: "shop" }),
  );
  const pluginPath = join(distRoot, "plugins/claude/alpha");
  mkdirSync(join(pluginPath, ".claude-plugin"), { recursive: true });
  writeFileSync(join(pluginPath, ".claude-plugin/plugin.json"), JSON.stringify({ name: "alpha" }));
  try {
    const recorder = recordingRunner();
    const claudeRecord: VendorRecord = { installs: [], uninstalls: [] };
    const claude = makeRecordingVendor("claude", join(sandbox, "claude"), claudeRecord);
    await assert.rejects(
      installWithRunner({ distRoot, vendors: [claude], silent: true }, recorder.run),
      /version/i,
    );
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("install passes an empty plugin list when the vendor dist subtree is empty", async () => {
  await withInstallFixture(
    { marketplaceName: "shop", plugins: [] },
    async ({ distRoot, sandbox }) => {
      const recorder = recordingRunner();
      const claudeRecord: VendorRecord = { installs: [], uninstalls: [] };
      const claude = makeRecordingVendor("claude", join(sandbox, "claude"), claudeRecord);
      await installWithRunner({ distRoot, vendors: [claude], silent: true }, recorder.run);
      assert.equal(claudeRecord.installs.length, 1);
      assert.deepEqual(claudeRecord.installs[0]!.plugins, []);
    },
  );
});
