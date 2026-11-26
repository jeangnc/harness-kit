import { test } from "node:test";
import { deepEqual, doesNotMatch, equal, match, ok, rejects } from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  lstatSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { installWithRunner, uninstallWithRunner, updateWithRunner } from "./index.js";
import type { CommandRunner } from "./runner.js";
import { makeFakeVendor } from "../vendor/fakeVendor.testutil.js";
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

interface PruneCall {
  readonly ctx: VendorInstallContext;
  readonly names: readonly string[];
}

interface VendorRecord {
  readonly installs: VendorInstallContext[];
  readonly refreshes: VendorInstallContext[];
  readonly uninstalls: VendorInstallContext[];
  readonly prunes: PruneCall[];
}

const codexTraits: Partial<Vendor> = {
  runtimeLayout: { kind: "nested", directories: ["profiles", "hooks", "configs"] },
  pluginSelection: "native",
};

function emptyRecord(): VendorRecord {
  return { installs: [], refreshes: [], uninstalls: [], prunes: [] };
}

function makeRecordingVendor(
  name: string,
  home: string,
  record: VendorRecord,
  extra: Partial<Vendor> = {},
): Vendor {
  return makeFakeVendor(name, {
    home,
    install: async (ctx) => {
      record.installs.push(ctx);
    },
    refresh: async (ctx) => {
      record.refreshes.push(ctx);
    },
    uninstall: async (ctx) => {
      record.uninstalls.push(ctx);
    },
    pruneStale: async (ctx, names) => {
      record.prunes.push({ ctx, names });
    },
    ...extra,
  });
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

const repository = { owner: "foo", name: "bar", slug: "foo/bar" };
const refs = { claude: "harness/claude", codex: "harness/codex" };

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

      equal(claudeRecord.installs.length, 1);
      equal(codexRecord.installs.length, 1);
      deepEqual(
        claudeRecord.installs[0]!.plugins.map((p) => p.name),
        ["alpha"],
      );
      deepEqual(
        codexRecord.installs[0]!.plugins.map((p) => p.name),
        ["beta"],
      );
      equal(claudeRecord.installs[0]!.marketplace, "shop");
      equal(claudeRecord.installs[0]!.distRoot, distRoot);
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
      ok(lstatSync(linked).isSymbolicLink(), "config link should have been applied");
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

      ok(!existsSync(join(claudeHome, "settings.json")), "dry run must not link");
      equal(claudeRecord.installs.length, 0, "dry run must not invoke vendor.install");
      const joined = logs.join("\n");
      match(joined, /settings\.json/);
      match(joined, /alpha/);
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
      match(joined, /would install 1 plugin\(s\)/);
      match(joined, /beta@2\.0\.0 \(skipped — disabled in settings\)/);
      doesNotMatch(joined, /alpha.*skipped/);
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

      equal(claudeRecord.uninstalls.length, 1);
      deepEqual(
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
    await rejects(
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
    await rejects(
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
      equal(claudeRecord.installs.length, 1);
      deepEqual(claudeRecord.installs[0]!.plugins, []);
    },
  );
});

test("install defaults the vendor context source to local", async () => {
  await withInstallFixture(
    { marketplaceName: "shop", plugins: [] },
    async ({ distRoot, sandbox }) => {
      const recorder = recordingRunner();
      const claudeRecord = emptyRecord();
      const claude = makeRecordingVendor("claude", join(sandbox, "claude"), claudeRecord);
      await installWithRunner({ distRoot, vendors: [claude], silent: true }, recorder.run);
      deepEqual(claudeRecord.installs[0]!.source, { kind: "local" });
    },
  );
});

test("install in remote mode threads the repository and the vendor's ref into the vendor context", async () => {
  await withInstallFixture(
    { marketplaceName: "shop", plugins: [] },
    async ({ distRoot, sandbox }) => {
      const recorder = recordingRunner();
      const claudeRecord = emptyRecord();
      const claude = makeRecordingVendor("claude", join(sandbox, "claude"), claudeRecord);
      await installWithRunner(
        {
          distRoot,
          vendors: [claude],
          silent: true,
          mode: "remote",
          repository,
          refs: { claude: "harness/claude" },
        },
        recorder.run,
      );
      deepEqual(claudeRecord.installs[0]!.source, {
        kind: "remote",
        repository,
        ref: "harness/claude",
      });
    },
  );
});

test("install in remote mode reads each vendor's ref from harness.yaml", async () => {
  await withInstallFixture(
    { marketplaceName: "shop", plugins: [] },
    async ({ distRoot, sandbox }) => {
      writeFileSync(
        join(sandbox, "harness.yaml"),
        "marketplace: shop\nowner: { name: foo }\nvendors: { claude: { ref: out/claude } }\n",
      );
      const claudeRecord = emptyRecord();
      const claude = makeRecordingVendor("claude", join(sandbox, "claude"), claudeRecord);
      await installWithRunner(
        {
          distRoot,
          repoRoot: sandbox,
          vendors: [claude],
          silent: true,
          mode: "remote",
          repository,
        },
        recordingRunner().run,
      );
      deepEqual(claudeRecord.installs[0]!.source, {
        kind: "remote",
        repository,
        ref: "out/claude",
      });
    },
  );
});

test("install in remote mode touches no vendor when one vendor has no ref", async () => {
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
      const vendors = [
        makeRecordingVendor("claude", join(sandbox, "claude"), claudeRecord),
        makeRecordingVendor("codex", join(sandbox, "codex"), codexRecord),
      ];
      await rejects(
        installWithRunner(
          {
            distRoot,
            vendors,
            silent: true,
            mode: "remote",
            repository,
            refs: { claude: "harness/claude" },
          },
          recordingRunner().run,
        ),
        /declare vendors\.codex\.ref/,
      );
      equal(claudeRecord.installs.length + codexRecord.installs.length, 0);
    },
  );
});

test("update defaults the vendor context source to remote", async () => {
  await withInstallFixture(
    { marketplaceName: "shop", plugins: [{ name: "alpha", vendor: "claude", version: "1.0.0" }] },
    async ({ distRoot, sandbox }) => {
      const record = emptyRecord();
      const claude = makeRecordingVendor("claude", join(sandbox, "claude"), record);

      await updateWithRunner(
        { distRoot, vendors: [claude], silent: true, repository, refs },
        recordingRunner().run,
      );

      equal(record.refreshes[0]!.source.kind, "remote");
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
        { distRoot, vendors: [claude], repository, refs, silent: true },
        recordingRunner().run,
      );

      equal(result.ok, false);
      equal(result.ok === false && result.error.kind, "not-installed");
      equal(record.refreshes.length, 0, "must not refresh when not installed");
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
        { distRoot, vendors: [claude], repository, refs, silent: true },
        recordingRunner().run,
      );

      equal(result.ok, true);
      equal(record.installs.length, 0, "update must not enable via vendor.install");
      equal(record.refreshes.length, 1);
      deepEqual(
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
        { distRoot, repoRoot: sandbox, vendors: [claude], repository, refs, silent: true },
        recordingRunner().run,
      );

      ok(!existsSync(join(claudeHome, "settings.json")), "update must not lay down config links");
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
          record.refreshes.length === 0
            ? new Map([
                ["alpha", "1.0.0"],
                ["beta", "1.0.0"],
              ])
            : new Map(record.refreshes[0]!.plugins.map((plugin) => [plugin.name, plugin.version])),
      });
      const logs: string[] = [];

      await updateWithRunner(
        { distRoot, vendors: [claude], repository, refs, log: (m) => logs.push(m) },
        recordingRunner().run,
      );

      const joined = logs.join("\n");
      match(joined, /alpha 1\.0\.0 → 2\.0\.0/);
      match(joined, /beta.*unchanged|unchanged.*beta/i);
      match(joined, /gamma.*\b2\.0\.0\b|added.*gamma|gamma.*added/i);
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
        { distRoot, vendors: [claude, codex], repository, refs, silent: true },
        recordingRunner().run,
      );

      equal(result.ok, true);
      equal(claudeRecord.refreshes.length, 1, "installed vendor is refreshed");
      equal(codexRecord.refreshes.length, 0, "uninstalled vendor is not refreshed");
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
          record.refreshes.length === 0
            ? new Map([
                ["alpha", "1.0.0"],
                ["beta", "1.0.0"],
              ])
            : new Map(record.refreshes[0]!.plugins.map((plugin) => [plugin.name, plugin.version])),
      });
      const logs: string[] = [];

      await updateWithRunner(
        { distRoot, vendors: [claude], repository, refs, log: (m) => logs.push(m) },
        recordingRunner().run,
      );

      const joined = logs.join("\n");
      match(joined, /alpha 1\.0\.0 → 2\.0\.0/);
      match(joined, /beta 1\.0\.0 → 2\.0\.0/, "disabled-but-shipped plugin is still refreshed");
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
        { distRoot, vendors: [claude], repository, refs, log: (m) => logs.push(m) },
        recordingRunner().run,
      );

      doesNotMatch(logs.join("\n"), /removed beta/, "a shipped plugin is not reported removed");
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
        { distRoot, vendors: [claude], repository, refs, log: (m) => logs.push(m) },
        recordingRunner().run,
      );

      match(logs.join("\n"), /removed legacy \(was 0\.9\.0\)/);
    },
  );
});

test("update, without --prune, points at --prune instead of removing the stale plugin", async () => {
  await withInstallFixture(
    {
      marketplaceName: "shop",
      plugins: [{ name: "alpha", vendor: "claude", version: "1.0.0" }],
    },
    async ({ distRoot, sandbox }) => {
      const record = emptyRecord();
      const claude = makeRecordingVendor("claude", join(sandbox, "claude"), record, {
        installedVersions: async () => new Map([["legacy", "0.9.0"]]),
      });
      const logs: string[] = [];

      await updateWithRunner(
        { distRoot, vendors: [claude], repository, refs, log: (m) => logs.push(m) },
        recordingRunner().run,
      );

      equal(record.prunes.length, 0, "nothing is removed without the flag");
      match(logs.join("\n"), /--prune/, "the report names the flag that would remove it");
    },
  );
});

test("update --prune removes a plugin that is no longer shipped", async () => {
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
        { distRoot, vendors: [claude], repository, refs, prune: true, log: (m) => logs.push(m) },
        recordingRunner().run,
      );

      deepEqual(
        record.prunes.map((p) => p.names),
        [["legacy"]],
        "only the unshipped plugin is pruned",
      );
      match(logs.join("\n"), /pruned legacy \(was 0\.9\.0\)/);
    },
  );
});

test("update --prune leaves a shipped plugin alone", async () => {
  await withInstallFixture(
    {
      marketplaceName: "shop",
      plugins: [{ name: "alpha", vendor: "claude", version: "1.0.0" }],
    },
    async ({ distRoot, sandbox }) => {
      const record = emptyRecord();
      const claude = makeRecordingVendor("claude", join(sandbox, "claude"), record, {
        installedVersions: async () => new Map([["alpha", "1.0.0"]]),
      });

      await updateWithRunner(
        { distRoot, vendors: [claude], repository, refs, prune: true },
        recordingRunner().run,
      );

      equal(record.prunes.length, 0, "vendor.pruneStale is not called with nothing stale");
    },
  );
});

test("update --prune --dry-run reports the prune without performing it", async () => {
  await withInstallFixture(
    {
      marketplaceName: "shop",
      plugins: [{ name: "alpha", vendor: "claude", version: "1.0.0" }],
    },
    async ({ distRoot, sandbox }) => {
      const record = emptyRecord();
      const claude = makeRecordingVendor("claude", join(sandbox, "claude"), record, {
        installedVersions: async () => new Map([["legacy", "0.9.0"]]),
      });
      const logs: string[] = [];

      await updateWithRunner(
        {
          distRoot,
          vendors: [claude],
          repository,
          refs,
          prune: true,
          dryRun: true,
          log: (m) => logs.push(m),
        },
        recordingRunner().run,
      );

      equal(record.prunes.length, 0, "a dry run performs no removal");
      match(
        logs.join("\n"),
        /would prune legacy \(was 0\.9\.0\)/,
        "a dry run states the intent, never a completed removal",
      );
      doesNotMatch(
        logs.join("\n"),
        /\bpruned legacy\b/,
        "a dry run never claims the removal happened",
      );
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
        { distRoot, vendors: [claude], repository, refs, dryRun: true, log: (m) => logs.push(m) },
        recordingRunner().run,
      );

      equal(result.ok, true);
      equal(record.refreshes.length, 0, "dry run must not refresh");
      equal(record.installs.length, 0, "dry run must not enable");
      match(logs.join("\n"), /alpha 1\.0\.0 → 2\.0\.0/);
    },
  );
});

test("update reports only versions present after native refresh", async () => {
  await withInstallFixture(
    {
      marketplaceName: "foo",
      plugins: [
        { name: "foo", vendor: "codex", version: "2.0.0" },
        { name: "bar", vendor: "codex", version: "2.0.0" },
        { name: "baz", vendor: "codex", version: "2.0.0" },
      ],
    },
    async ({ distRoot, sandbox }) => {
      const record = emptyRecord();
      let versions = new Map([
        ["foo", "1.0.0"],
        ["bar", "1.0.0"],
      ]);
      const vendor = makeRecordingVendor("codex", join(sandbox, "codex"), record, {
        installedVersions: async () => versions,
        refresh: async () => {
          versions = new Map([
            ["foo", "2.0.0"],
            ["bar", "1.0.0"],
          ]);
        },
      });
      const result = await updateWithRunner(
        { distRoot, vendors: [vendor], repository, refs, silent: true },
        recordingRunner().run,
      );
      deepEqual(result, {
        ok: true,
        value: {
          changes: [
            { kind: "unchanged", name: "bar", at: "1.0.0" },
            { kind: "changed", name: "foo", from: "1.0.0", to: "2.0.0" },
          ],
        },
      });
    },
  );
});

test("Codex install dry run leaves plugin selection to the native runtime", async () => {
  await withInstallFixture(
    { marketplaceName: "foo", plugins: [{ name: "foo", vendor: "codex", version: "1.0.0" }] },
    async ({ distRoot, sandbox }) => {
      const logs: string[] = [];
      const vendor = makeRecordingVendor(
        "codex",
        join(sandbox, "codex"),
        emptyRecord(),
        codexTraits,
      );
      await installWithRunner(
        { distRoot, vendors: [vendor], dryRun: true, log: (message) => logs.push(message) },
        recordingRunner().run,
      );
      match(logs.join("\n"), /candidates.*native.*execution/);
      doesNotMatch(logs.join("\n"), /would install/);
    },
  );
});

for (const operation of [installWithRunner, updateWithRunner, uninstallWithRunner]) {
  test(`${operation.name} rejects a managed runtime link before mutation`, async () => {
    await withInstallFixture(
      { marketplaceName: "foo", plugins: [{ name: "foo", vendor: "codex", version: "1.0.0" }] },
      async ({ distRoot, sandbox }) => {
        const home = join(sandbox, "codex");
        const source = join(distRoot, "config.toml");
        mkdirSync(home);
        writeFileSync(source, "preserved");
        symlinkSync(source, join(home, "config.toml"));
        const record = emptyRecord();
        const vendor = makeRecordingVendor("codex", home, record, codexTraits);
        await rejects(
          operation({ distRoot, vendors: [vendor], refs, silent: true }, recordingRunner().run),
          /migrate-runtime/,
        );
        deepEqual(record, emptyRecord());
        await operation(
          { distRoot, vendors: [vendor], refs, silent: true, dryRun: true },
          recordingRunner().run,
        );
        deepEqual(record, emptyRecord());
      },
    );
  });
}
