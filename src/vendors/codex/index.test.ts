import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { codexVendor, makeCodexVendor } from "./index.js";
import type { VendorInstallContext } from "../../vendor/schema.js";

function fixture(
  entries: ReadonlyArray<{
    name: string;
    enabled: boolean;
    installed: boolean;
    version: string;
  }> = [],
) {
  const calls: string[][] = [];
  const ctx: VendorInstallContext = {
    distRoot: "/tmp/foo/dist",
    marketplace: "foo-market",
    mode: "local",
    plugins: [{ name: "foo", version: "2.0.0", path: "/tmp/foo/dist/codex/plugins/foo" }],
    run: async (cmd, args) => {
      calls.push([cmd, ...args]);
      if (args.includes("list")) {
        return JSON.stringify({
          installed: entries
            .filter((p) => p.installed)
            .map((p) => ({ ...p, marketplaceName: "foo-market" })),
          available: entries
            .filter((p) => !p.installed)
            .map((p) => ({ ...p, marketplaceName: "foo-market" })),
        });
      }
      if (args[1] === "add") return JSON.stringify({ version: "2.0.0" });
      return JSON.stringify({ errors: [] });
    },
    log: () => undefined,
  };
  return { ctx, calls, vendor: makeCodexVendor("/tmp/foo/home") };
}

test("Codex leaves every runtime config user-owned", () => {
  for (const name of ["config.toml", "AGENTS.md", "hooks.json", "foo.config.toml"]) {
    assert.equal(codexVendor.configPlacement(name), null);
  }
});

test("Codex emits a marketplace at a native-supported location", () => {
  assert.equal(codexVendor.marketplaceManifestPath, "codex/.claude-plugin/marketplace.json");
});

test("local installation registers the vendor catalog before installing enabled plugins", async () => {
  const { ctx, calls, vendor } = fixture([
    { name: "foo", enabled: true, installed: false, version: "2.0.0" },
  ]);
  await vendor.install(ctx);
  assert.deepEqual(calls[0], [
    "codex",
    "plugin",
    "marketplace",
    "add",
    "/tmp/foo/dist/codex",
    "--json",
  ]);
  assert.ok(calls.some((call) => call.join(" ") === "codex plugin add foo@foo-market --json"));
});

test("installation leaves disabled plugins unchanged", async () => {
  const { ctx, calls, vendor } = fixture([
    { name: "foo", enabled: false, installed: false, version: "2.0.0" },
  ]);
  await vendor.install(ctx);
  assert.equal(
    calls.some((call) => call[2] === "add"),
    false,
  );
});

test("refresh refuses to re-enable a disabled installed plugin", async () => {
  const { ctx, calls, vendor } = fixture([
    { name: "foo", enabled: false, installed: true, version: "1.0.0" },
  ]);
  await assert.rejects(vendor.refresh(ctx), /disabled.*foo/);
  assert.equal(
    calls.some((call) => call[2] === "add"),
    false,
  );
});

test("refresh leaves a current disabled plugin unchanged", async () => {
  const { ctx, calls, vendor } = fixture([
    { name: "foo", enabled: false, installed: true, version: "2.0.0" },
  ]);
  await vendor.refresh(ctx);
  assert.equal(
    calls.some((call) => call[2] === "add"),
    false,
  );
});

test("refresh installs the new version of an enabled plugin through Codex", async () => {
  const { ctx, calls, vendor } = fixture([
    { name: "foo", enabled: true, installed: true, version: "1.0.0" },
  ]);
  await vendor.refresh(ctx);
  assert.ok(calls.some((call) => call.join(" ") === "codex plugin add foo@foo-market --json"));
});

test("remote installation refreshes its configured Git marketplace", async () => {
  const { ctx, calls, vendor } = fixture([]);
  await vendor.install({ ...ctx, mode: "remote" });
  assert.deepEqual(calls[0], ["codex", "plugin", "marketplace", "upgrade", "foo-market", "--json"]);
  assert.equal(
    calls.some((call) => call.includes(ctx.distRoot)),
    false,
  );
});

test("native command failures stop installation", async () => {
  const { ctx, vendor } = fixture();
  await assert.rejects(
    vendor.install({
      ...ctx,
      run: async () => {
        throw new Error("foo failed");
      },
    }),
    /foo failed/,
  );
});

test("invalid native output is rejected before plugin mutation", async () => {
  const { ctx, vendor } = fixture();
  await assert.rejects(vendor.install({ ...ctx, run: async () => "invalid" }), /Codex plugin list/);
});

test("installed versions come from the native registry", async () => {
  const { ctx, vendor } = fixture([
    { name: "foo", enabled: false, installed: true, version: "1.0.0" },
  ]);
  assert.deepEqual(await vendor.installedVersions(ctx), new Map([["foo", "1.0.0"]]));
  assert.equal(await vendor.isInstalled(ctx), true);
});

test("uninstall delegates plugin and marketplace removal", async () => {
  const { ctx, calls, vendor } = fixture([
    { name: "foo", enabled: false, installed: true, version: "1.0.0" },
  ]);
  await vendor.uninstall(ctx);
  assert.ok(calls.some((call) => call.join(" ") === "codex plugin remove foo@foo-market --json"));
  assert.deepEqual(calls.at(-1), [
    "codex",
    "plugin",
    "marketplace",
    "remove",
    "foo-market",
    "--json",
  ]);
});

test("pruning delegates only the named plugin removal", async () => {
  const { ctx, calls, vendor } = fixture();
  await vendor.pruneStale(ctx, ["bar"]);
  assert.deepEqual(calls, [["codex", "plugin", "remove", "bar@foo-market", "--json"]]);
});

test("installation does not write user files or delete cached content itself", async () => {
  const home = await mkdtemp(join(tmpdir(), "harness-native-"));
  try {
    const cache = join(home, "plugins/cache/foo-market/foo/1.0.0");
    await mkdir(cache, { recursive: true });
    await writeFile(join(cache, "foo"), "foo");
    await writeFile(join(home, "config.toml"), "foo = true\n");
    const { ctx } = fixture([{ name: "foo", enabled: true, installed: true, version: "1.0.0" }]);
    await makeCodexVendor(home).install(ctx);
    assert.equal(await readFile(join(cache, "foo"), "utf8"), "foo");
    assert.equal(await readFile(join(home, "config.toml"), "utf8"), "foo = true\n");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("remote marketplace errors stop plugin installation", async () => {
  const { ctx, vendor } = fixture();
  await assert.rejects(
    vendor.install({
      ...ctx,
      mode: "remote",
      run: async () => JSON.stringify({ errors: ["foo"] }),
    }),
    /marketplace upgrade/,
  );
});

test("native installation rejects an unexpected installed version", async () => {
  const { ctx, vendor } = fixture([
    { name: "foo", enabled: true, installed: false, version: "2.0.0" },
  ]);
  const run = ctx.run;
  await assert.rejects(
    vendor.install({
      ...ctx,
      run: async (cmd, args) =>
        args[1] === "add" ? JSON.stringify({ version: "1.0.0" }) : run(cmd, args),
    }),
    /expected foo@2.0.0/,
  );
});

test("native commands target the vendor's configured home", async () => {
  const { ctx, vendor } = fixture();
  const run = ctx.run;
  await vendor.install({
    ...ctx,
    run: async (cmd, args, options) => {
      assert.equal(options?.env["CODEX_HOME"], vendor.home);
      assert.equal(options?.cwd, "/");
      return run(cmd, args);
    },
  });
});

test("relative Codex homes are resolved before changing command directories", () => {
  assert.equal(makeCodexVendor("foo").home, resolve("foo"));
});
