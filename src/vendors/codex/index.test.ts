import { test } from "node:test";
import { deepEqual, equal, ok, rejects } from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { vendor as codexVendor, makeVendor } from "./index.js";
import type { VendorInstallContext } from "../../vendor/schema.js";

function fixture(
  entries: ReadonlyArray<{
    name: string;
    enabled: boolean;
    installed: boolean;
    version: string;
  }> = [],
  registered: readonly string[] = [],
) {
  const calls: string[][] = [];
  const ctx: VendorInstallContext = {
    distRoot: "/tmp/foo/dist",
    marketplace: "foo-market",
    source: { kind: "local" },
    plugins: [{ name: "foo", version: "2.0.0", path: "/tmp/foo/dist/codex/plugins/foo" }],
    run: async (cmd, args) => {
      calls.push([cmd, ...args]);
      if (args[1] === "marketplace" && args[2] === "list") {
        return JSON.stringify({ marketplaces: registered.map((name) => ({ name })) });
      }
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
      if (args[1] === "marketplace" && args[2] === "add") {
        return JSON.stringify({ marketplaceName: "foo-market" });
      }
      return JSON.stringify({ errors: [] });
    },
    log: () => undefined,
  };
  return { ctx, calls, vendor: makeVendor("/tmp/foo/home") };
}

test("Codex leaves every runtime config user-owned", () => {
  for (const name of ["config.toml", "AGENTS.md", "hooks.json", "foo.config.toml"]) {
    equal(codexVendor.configPlacement(name), null);
  }
});

test("Codex emits its catalog at the native .agents marketplace path", () => {
  equal(codexVendor.catalogPath, ".agents/plugins/marketplace.json");
});

test("local installation registers the vendor catalog before installing enabled plugins", async () => {
  const { ctx, calls, vendor } = fixture([
    { name: "foo", enabled: true, installed: false, version: "2.0.0" },
  ]);
  await vendor.install(ctx);
  deepEqual(calls[0], ["codex", "plugin", "marketplace", "add", "/tmp/foo/dist/codex", "--json"]);
  ok(calls.some((call) => call.join(" ") === "codex plugin add foo@foo-market --json"));
});

test("installation leaves disabled plugins unchanged", async () => {
  const { ctx, calls, vendor } = fixture([
    { name: "foo", enabled: false, installed: false, version: "2.0.0" },
  ]);
  await vendor.install(ctx);
  equal(
    calls.some((call) => call[2] === "add"),
    false,
  );
});

test("refresh skips a stale disabled plugin without enabling it", async () => {
  const { ctx, calls, vendor } = fixture([
    { name: "foo", enabled: false, installed: true, version: "1.0.0" },
  ]);
  const logs: string[] = [];
  await vendor.refresh({ ...ctx, log: (line) => logs.push(line) });
  equal(
    calls.some((call) => call[2] === "add"),
    false,
  );
  ok(logs.some((line) => line.includes("skipped disabled foo@1.0.0")));
});

test("refresh leaves a current disabled plugin unchanged", async () => {
  const { ctx, calls, vendor } = fixture([
    { name: "foo", enabled: false, installed: true, version: "2.0.0" },
  ]);
  await vendor.refresh(ctx);
  equal(
    calls.some((call) => call[2] === "add"),
    false,
  );
});

test("local installation re-adds an enabled plugin already at the shipped version", async () => {
  const { ctx, calls, vendor } = fixture([
    { name: "foo", enabled: true, installed: true, version: "2.0.0" },
  ]);
  await vendor.install(ctx);
  ok(calls.some((call) => call.join(" ") === "codex plugin add foo@foo-market --json"));
});

test("refresh installs the new version of an enabled plugin through Codex", async () => {
  const { ctx, calls, vendor } = fixture([
    { name: "foo", enabled: true, installed: true, version: "1.0.0" },
  ]);
  await vendor.refresh(ctx);
  ok(calls.some((call) => call.join(" ") === "codex plugin add foo@foo-market --json"));
});

test("remote installation registers the codex ref of the repository before upgrading it", async () => {
  const { ctx, calls, vendor } = fixture([]);
  await vendor.install({
    ...ctx,
    source: {
      kind: "remote",
      repository: { owner: "foo", name: "bar", slug: "foo/bar" },
      ref: "harness/codex",
    },
  });
  deepEqual(calls.slice(0, 3), [
    ["codex", "plugin", "marketplace", "list", "--json"],
    ["codex", "plugin", "marketplace", "add", "foo/bar", "--ref", "harness/codex", "--json"],
    ["codex", "plugin", "marketplace", "upgrade", "foo-market", "--json"],
  ]);
  equal(
    calls.some((call) => call.includes(ctx.distRoot)),
    false,
  );
});

test("remote refresh re-registers an existing marketplace so a changed ref takes effect", async () => {
  const { ctx, calls, vendor } = fixture([], ["foo-market"]);
  await vendor.refresh({
    ...ctx,
    source: {
      kind: "remote",
      repository: { owner: "foo", name: "bar", slug: "foo/bar" },
      ref: "harness/codex",
    },
  });
  deepEqual(calls.slice(1, 3), [
    ["codex", "plugin", "marketplace", "remove", "foo-market", "--json"],
    ["codex", "plugin", "marketplace", "add", "foo/bar", "--ref", "harness/codex", "--json"],
  ]);
});

test("native command failures stop installation", async () => {
  const { ctx, vendor } = fixture();
  await rejects(
    vendor.install({
      ...ctx,
      run: async () => {
        throw new Error("foo failed");
      },
    }),
    /Codex marketplace add failed; native output withheld/,
  );
});

test("invalid native output is rejected before plugin mutation", async () => {
  const { ctx, vendor } = fixture();
  const run = ctx.run;
  await rejects(
    vendor.install({
      ...ctx,
      run: async (cmd, args) => (args[1] === "list" ? "invalid" : run(cmd, args)),
    }),
    /Codex plugin list/,
  );
});

test("installed versions come from the native registry", async () => {
  const { ctx, vendor } = fixture([
    { name: "foo", enabled: false, installed: true, version: "1.0.0" },
  ]);
  deepEqual(await vendor.installedVersions(ctx), new Map([["foo", "1.0.0"]]));
  equal(await vendor.isInstalled(ctx), true);
});

test("uninstall delegates plugin and marketplace removal", async () => {
  const { ctx, calls, vendor } = fixture([
    { name: "foo", enabled: false, installed: true, version: "1.0.0" },
  ]);
  await vendor.uninstall(ctx);
  ok(calls.some((call) => call.join(" ") === "codex plugin remove foo@foo-market --json"));
  deepEqual(calls.at(-1), ["codex", "plugin", "marketplace", "remove", "foo-market", "--json"]);
});

test("pruning delegates only the named plugin removal", async () => {
  const { ctx, calls, vendor } = fixture();
  await vendor.pruneStale(ctx, ["bar"]);
  deepEqual(calls, [["codex", "plugin", "remove", "bar@foo-market", "--json"]]);
});

test("installation does not write user files or delete cached content itself", async () => {
  const home = await mkdtemp(join(tmpdir(), "harness-native-"));
  try {
    const cache = join(home, "plugins/cache/foo-market/foo/1.0.0");
    await mkdir(cache, { recursive: true });
    await writeFile(join(cache, "foo"), "foo");
    await writeFile(join(home, "config.toml"), "foo = true\n");
    const { ctx } = fixture([{ name: "foo", enabled: true, installed: true, version: "1.0.0" }]);
    await makeVendor(home).install(ctx);
    equal(await readFile(join(cache, "foo"), "utf8"), "foo");
    equal(await readFile(join(home, "config.toml"), "utf8"), "foo = true\n");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("remote marketplace errors stop plugin installation", async () => {
  const { ctx, vendor } = fixture();
  await rejects(
    vendor.install({
      ...ctx,
      source: {
        kind: "remote",
        repository: { owner: "foo", name: "bar", slug: "foo/bar" },
        ref: "harness/codex",
      },
      run: async (_cmd, args) =>
        JSON.stringify(
          args[2] === "list"
            ? { marketplaces: [] }
            : args[2] === "add"
              ? { marketplaceName: "foo-market" }
              : { errors: ["foo"] },
        ),
    }),
    /marketplace upgrade/,
  );
});

test("native installation rejects an unexpected installed version", async () => {
  const { ctx, vendor } = fixture([
    { name: "foo", enabled: true, installed: false, version: "2.0.0" },
  ]);
  const run = ctx.run;
  await rejects(
    vendor.install({
      ...ctx,
      run: async (cmd, args) =>
        args[1] === "add" ? JSON.stringify({ version: "1.0.0" }) : run(cmd, args),
    }),
    /expected foo@foo-market at version 2.0.0/,
  );
});

test("native commands target the vendor's configured home", async () => {
  const { ctx, vendor } = fixture();
  const run = ctx.run;
  await vendor.install({
    ...ctx,
    run: async (cmd, args, options) => {
      equal(options?.env["CODEX_HOME"], vendor.home);
      equal(options?.cwd, "/");
      return run(cmd, args);
    },
  });
});

test("relative Codex homes are resolved before changing command directories", () => {
  equal(makeVendor("foo").home, resolve("foo"));
});
