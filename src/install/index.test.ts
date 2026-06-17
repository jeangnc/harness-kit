import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { installWithRunner, uninstallWithRunner, updateWithRunner } from "./index.js";
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
  readonly refreshes: VendorInstallContext[];
  readonly uninstalls: VendorInstallContext[];
}

function emptyRecord(): VendorRecord {
  return { installs: [], refreshes: [], uninstalls: [] };
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
    marketplaceManifestPath: `${name}/.${name}-plugin/marketplace.json`,
    vendorOutDir: (outRoot) => join(outRoot, name),
    pluginOutDir: (outRoot, pluginName) => join(outRoot, name, "plugins", pluginName),
    configsOutDir: (outRoot) => join(outRoot, name, "configs"),
    emitPluginManifest: async () => undefined,
    emitMarketplaceManifest: async () => undefined,
    install: async (ctx) => {
      record.installs.push(ctx);
    },
    refresh: async (ctx) => {
      record.refreshes.push(ctx);
    },
    uninstall: async (ctx) => {
      record.uninstalls.push(ctx);
    },
    partitionPlugins: (ctx) => ({ enabled: ctx.plugins, disabled: [] }),
    isInstalled: async () => true,
    installedVersions: async () => new Map(),
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
  const vendors = new Set(options.plugins.map((p) => p.vendor));
  if (vendors.size === 0) vendors.add("claude");
  for (const vendor of vendors) {
    mkdirSync(join(distRoot, vendor, `.${vendor}-plugin`), { recursive: true });
    writeFileSync(
      join(distRoot, vendor, `.${vendor}-plugin/marketplace.json`),
      JSON.stringify({ name: options.marketplaceName }),
    );
  }
  for (const plugin of options.plugins) {
    const pluginPath = join(distRoot, plugin.vendor, "plugins", plugin.name);
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
      const claudeRecord = emptyRecord();
      const codexRecord = emptyRecord();
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
      const distConfigsDir = join(distRoot, "claude/configs");
      mkdirSync(distConfigsDir, { recursive: true });
      writeFileSync(join(distConfigsDir, "settings.json"), "{}");
      writeFileSync(
        join(distRoot, "configs.json"),
        JSON.stringify({
          links: [
            {
              src: "claude/configs/settings.json",
              vendors: ["claude"],
              destRel: "settings.json",
              kind: "file",
            },
          ],
        }),
      );
      const recorder = recordingRunner();
      const claudeHome = join(sandbox, "claude");
      const claudeRecord = emptyRecord();
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
      const distConfigsDir = join(distRoot, "claude/configs");
      mkdirSync(distConfigsDir, { recursive: true });
      writeFileSync(join(distConfigsDir, "settings.json"), "{}");
      writeFileSync(
        join(distRoot, "configs.json"),
        JSON.stringify({
          links: [
            {
              src: "claude/configs/settings.json",
              vendors: ["claude"],
              destRel: "settings.json",
              kind: "file",
            },
          ],
        }),
      );
      const recorder = recordingRunner();
      const claudeHome = join(sandbox, "claude");
      const claudeRecord = emptyRecord();
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

test("install --dry-run lists a vendor's disabled plugins under the skipped marker", async () => {
  await withInstallFixture(
    {
      marketplaceName: "shop",
      plugins: [
        { name: "alpha", vendor: "claude", version: "1.0.0" },
        { name: "beta", vendor: "claude", version: "2.0.0" },
      ],
    },
    async ({ distRoot, sandbox }) => {
      const record = emptyRecord();
      const vendor = makeRecordingVendor("claude", join(sandbox, "claude"), record, {
        partitionPlugins: (ctx) => ({
          enabled: ctx.plugins.filter((p) => p.name !== "beta"),
          disabled: ctx.plugins.filter((p) => p.name === "beta"),
        }),
      });
      const logs: string[] = [];

      await installWithRunner(
        { distRoot, repoRoot: sandbox, vendors: [vendor], dryRun: true, log: (m) => logs.push(m) },
        recordingRunner().run,
      );

      const joined = logs.join("\n");
      assert.match(joined, /would install 1 plugin\(s\)/);
      assert.match(joined, /beta@2\.0\.0 \(skipped — disabled in settings\)/);
      assert.doesNotMatch(joined, /alpha.*skipped/);
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
      const claudeRecord = emptyRecord();
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
  mkdirSync(join(distRoot, "claude/.claude-plugin"), { recursive: true });
  writeFileSync(join(distRoot, "claude/.claude-plugin/marketplace.json"), JSON.stringify({}));
  try {
    const recorder = recordingRunner();
    const claudeRecord = emptyRecord();
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
  mkdirSync(join(distRoot, "claude/.claude-plugin"), { recursive: true });
  writeFileSync(
    join(distRoot, "claude/.claude-plugin/marketplace.json"),
    JSON.stringify({ name: "shop" }),
  );
  const pluginPath = join(distRoot, "claude/plugins/alpha");
  mkdirSync(join(pluginPath, ".claude-plugin"), { recursive: true });
  writeFileSync(join(pluginPath, ".claude-plugin/plugin.json"), JSON.stringify({ name: "alpha" }));
  try {
    const recorder = recordingRunner();
    const claudeRecord = emptyRecord();
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
      const claudeRecord = emptyRecord();
      const claude = makeRecordingVendor("claude", join(sandbox, "claude"), claudeRecord);
      await installWithRunner({ distRoot, vendors: [claude], silent: true }, recorder.run);
      assert.equal(claudeRecord.installs.length, 1);
      assert.deepEqual(claudeRecord.installs[0]!.plugins, []);
    },
  );
});

test("install defaults the vendor context mode to local", async () => {
  await withInstallFixture(
    { marketplaceName: "shop", plugins: [] },
    async ({ distRoot, sandbox }) => {
      const recorder = recordingRunner();
      const claudeRecord = emptyRecord();
      const claude = makeRecordingVendor("claude", join(sandbox, "claude"), claudeRecord);
      await installWithRunner({ distRoot, vendors: [claude], silent: true }, recorder.run);
      assert.equal(claudeRecord.installs[0]!.mode, "local");
    },
  );
});

test("install threads the requested mode into the vendor context", async () => {
  await withInstallFixture(
    { marketplaceName: "shop", plugins: [] },
    async ({ distRoot, sandbox }) => {
      const recorder = recordingRunner();
      const claudeRecord = emptyRecord();
      const claude = makeRecordingVendor("claude", join(sandbox, "claude"), claudeRecord);
      await installWithRunner(
        { distRoot, vendors: [claude], silent: true, mode: "remote" },
        recorder.run,
      );
      assert.equal(claudeRecord.installs[0]!.mode, "remote");
    },
  );
});

test("update returns a not-installed error when no vendor reports an existing install", async () => {
  await withInstallFixture(
    {
      marketplaceName: "shop",
      plugins: [{ name: "alpha", vendor: "claude", version: "1.0.0" }],
    },
    async ({ distRoot, sandbox }) => {
      const record = emptyRecord();
      const claude = makeRecordingVendor("claude", join(sandbox, "claude"), record, {
        isInstalled: async () => false,
      });

      const result = await updateWithRunner(
        { distRoot, vendors: [claude], silent: true },
        recordingRunner().run,
      );

      assert.equal(result.ok, false);
      assert.equal(result.ok === false && result.error.kind, "not-installed");
      assert.equal(record.refreshes.length, 0, "must not refresh when not installed");
    },
  );
});

test("update invokes vendor.refresh and never vendor.install when the harness is installed", async () => {
  await withInstallFixture(
    {
      marketplaceName: "shop",
      plugins: [{ name: "alpha", vendor: "claude", version: "2.0.0" }],
    },
    async ({ distRoot, sandbox }) => {
      const record = emptyRecord();
      const claude = makeRecordingVendor("claude", join(sandbox, "claude"), record, {
        isInstalled: async () => true,
      });

      const result = await updateWithRunner(
        { distRoot, vendors: [claude], silent: true },
        recordingRunner().run,
      );

      assert.equal(result.ok, true);
      assert.equal(record.installs.length, 0, "update must not enable via vendor.install");
      assert.equal(record.refreshes.length, 1);
      assert.deepEqual(
        record.refreshes[0]!.plugins.map((p) => p.name),
        ["alpha"],
      );
    },
  );
});

test("update does not apply config links", async () => {
  await withInstallFixture(
    {
      marketplaceName: "shop",
      plugins: [{ name: "alpha", vendor: "claude", version: "1.0.0" }],
    },
    async ({ distRoot, sandbox }) => {
      const distConfigsDir = join(distRoot, "claude/configs");
      mkdirSync(distConfigsDir, { recursive: true });
      writeFileSync(join(distConfigsDir, "settings.json"), "{}");
      writeFileSync(
        join(distRoot, "configs.json"),
        JSON.stringify({
          links: [
            {
              src: "claude/configs/settings.json",
              vendors: ["claude"],
              destRel: "settings.json",
              kind: "file",
            },
          ],
        }),
      );
      const claudeHome = join(sandbox, "claude");
      const record = emptyRecord();
      const claude = makeRecordingVendor("claude", claudeHome, record);

      await updateWithRunner(
        { distRoot, repoRoot: sandbox, vendors: [claude], silent: true },
        recordingRunner().run,
      );

      assert.ok(
        !existsSync(join(claudeHome, "settings.json")),
        "update must not lay down config links",
      );
    },
  );
});

test("update reports added, changed, and unchanged plugins against the installed versions", async () => {
  await withInstallFixture(
    {
      marketplaceName: "shop",
      plugins: [
        { name: "alpha", vendor: "claude", version: "2.0.0" },
        { name: "beta", vendor: "claude", version: "1.0.0" },
        { name: "gamma", vendor: "claude", version: "1.0.0" },
      ],
    },
    async ({ distRoot, sandbox }) => {
      const record = emptyRecord();
      const claude = makeRecordingVendor("claude", join(sandbox, "claude"), record, {
        installedVersions: async () =>
          new Map([
            ["alpha", "1.0.0"],
            ["beta", "1.0.0"],
          ]),
      });
      const logs: string[] = [];

      await updateWithRunner(
        { distRoot, vendors: [claude], log: (m) => logs.push(m) },
        recordingRunner().run,
      );

      const joined = logs.join("\n");
      assert.match(joined, /alpha 1\.0\.0 → 2\.0\.0/);
      assert.match(joined, /beta.*unchanged|unchanged.*beta/i);
      assert.match(joined, /gamma.*\b2\.0\.0\b|added.*gamma|gamma.*added/i);
    },
  );
});

test("update refreshes only the vendors that report an existing install", async () => {
  await withInstallFixture(
    {
      marketplaceName: "shop",
      plugins: [
        { name: "alpha", vendor: "claude", version: "1.0.0" },
        { name: "beta", vendor: "codex", version: "1.0.0" },
      ],
    },
    async ({ distRoot, sandbox }) => {
      const claudeRecord = emptyRecord();
      const codexRecord = emptyRecord();
      const claude = makeRecordingVendor("claude", join(sandbox, "claude"), claudeRecord, {
        isInstalled: async () => true,
      });
      const codex = makeRecordingVendor("codex", join(sandbox, "codex"), codexRecord, {
        isInstalled: async () => false,
      });

      const result = await updateWithRunner(
        { distRoot, vendors: [claude, codex], silent: true },
        recordingRunner().run,
      );

      assert.equal(result.ok, true);
      assert.equal(claudeRecord.refreshes.length, 1, "installed vendor is refreshed");
      assert.equal(codexRecord.refreshes.length, 0, "uninstalled vendor is not refreshed");
    },
  );
});

test("update reports every shipped plugin regardless of enabled state", async () => {
  await withInstallFixture(
    {
      marketplaceName: "shop",
      plugins: [
        { name: "alpha", vendor: "claude", version: "2.0.0" },
        { name: "beta", vendor: "claude", version: "2.0.0" },
      ],
    },
    async ({ distRoot, sandbox }) => {
      const record = emptyRecord();
      const claude = makeRecordingVendor("claude", join(sandbox, "claude"), record, {
        partitionPlugins: (c) => ({
          enabled: c.plugins.filter((p) => p.name !== "beta"),
          disabled: c.plugins.filter((p) => p.name === "beta"),
        }),
        installedVersions: async () =>
          new Map([
            ["alpha", "1.0.0"],
            ["beta", "1.0.0"],
          ]),
      });
      const logs: string[] = [];

      await updateWithRunner(
        { distRoot, vendors: [claude], log: (m) => logs.push(m) },
        recordingRunner().run,
      );

      const joined = logs.join("\n");
      assert.match(joined, /alpha 1\.0\.0 → 2\.0\.0/);
      assert.match(
        joined,
        /beta 1\.0\.0 → 2\.0\.0/,
        "disabled-but-shipped plugin is still refreshed",
      );
    },
  );
});

test("update does not report a cached-but-shipped plugin as removed", async () => {
  await withInstallFixture(
    {
      marketplaceName: "shop",
      plugins: [
        { name: "alpha", vendor: "claude", version: "1.0.0" },
        { name: "beta", vendor: "claude", version: "1.0.0" },
      ],
    },
    async ({ distRoot, sandbox }) => {
      const record = emptyRecord();
      const claude = makeRecordingVendor("claude", join(sandbox, "claude"), record, {
        installedVersions: async () =>
          new Map([
            ["alpha", "1.0.0"],
            ["beta", "1.0.0"],
          ]),
      });
      const logs: string[] = [];

      await updateWithRunner(
        { distRoot, vendors: [claude], log: (m) => logs.push(m) },
        recordingRunner().run,
      );

      assert.doesNotMatch(
        logs.join("\n"),
        /removed beta/,
        "a shipped plugin is not reported removed",
      );
    },
  );
});

test("update reports a plugin that is no longer shipped as removed", async () => {
  await withInstallFixture(
    {
      marketplaceName: "shop",
      plugins: [{ name: "alpha", vendor: "claude", version: "1.0.0" }],
    },
    async ({ distRoot, sandbox }) => {
      const record = emptyRecord();
      const claude = makeRecordingVendor("claude", join(sandbox, "claude"), record, {
        installedVersions: async () =>
          new Map([
            ["alpha", "1.0.0"],
            ["legacy", "0.9.0"],
          ]),
      });
      const logs: string[] = [];

      await updateWithRunner(
        { distRoot, vendors: [claude], log: (m) => logs.push(m) },
        recordingRunner().run,
      );

      assert.match(logs.join("\n"), /removed legacy \(was 0\.9\.0\)/);
    },
  );
});

test("update --dry-run reports the plan without invoking vendor.refresh", async () => {
  await withInstallFixture(
    {
      marketplaceName: "shop",
      plugins: [{ name: "alpha", vendor: "claude", version: "2.0.0" }],
    },
    async ({ distRoot, sandbox }) => {
      const record = emptyRecord();
      const claude = makeRecordingVendor("claude", join(sandbox, "claude"), record, {
        installedVersions: async () => new Map([["alpha", "1.0.0"]]),
      });
      const logs: string[] = [];

      const result = await updateWithRunner(
        { distRoot, vendors: [claude], dryRun: true, log: (m) => logs.push(m) },
        recordingRunner().run,
      );

      assert.equal(result.ok, true);
      assert.equal(record.refreshes.length, 0, "dry run must not refresh");
      assert.equal(record.installs.length, 0, "dry run must not enable");
      assert.match(logs.join("\n"), /alpha 1\.0\.0 → 2\.0\.0/);
    },
  );
});
