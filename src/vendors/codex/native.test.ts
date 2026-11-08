import { deepEqual, doesNotMatch, equal, match, ok, rejects } from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";

import { installSelectedPlugins, listCodexMcp, listCodexPlugins } from "./native.js";
import type { CodexPluginEntry } from "./native.js";
import type { CommandRunner } from "../../install/runner.js";

async function fixture(t: TestContext, entries: readonly CodexPluginEntry[] = []) {
  const home = await mkdtemp(join(tmpdir(), "harness-codex-native-"));
  t.after(async () => rm(home, { recursive: true, force: true }));
  const path = join(home, "config.toml");
  const contents = Buffer.from('\ufeff[plugins."foo@foo-market"]\r\nenabled = false\r\n');
  await writeFile(path, contents);
  const calls: string[][] = [];
  let installed = [...entries];
  const run: CommandRunner = async (cmd, args, options) => {
    calls.push([cmd, ...args]);
    equal(options?.env["CODEX_HOME"], home);
    equal(options?.cwd, "/");
    if (args[1] === "marketplace") {
      await writeFile(path, "marketplace = true\n");
      return JSON.stringify({ marketplaceName: "foo-market" });
    }
    if (args[1] === "list") return JSON.stringify({ installed, available: [] });
    if (args[1] === "add") {
      installed = [plugin({ enabled: true, version: "2.0.0" })];
      await writeFile(path, "enabled = true\n");
      return JSON.stringify({ version: "2.0.0" });
    }
    throw new Error("Unexpected native command");
  };
  const options = {
    home,
    marketplaces: [{ name: "foo-market", path: join(home, "dist/codex") }],
    plugins: [{ key: "foo@foo-market", version: "2.0.0" }],
    run,
  };
  return { options, path, contents, calls, backup: join(home, "config.before-install.toml") };
}

function plugin(overrides: Partial<CodexPluginEntry> = {}): CodexPluginEntry {
  return {
    name: "foo",
    marketplaceName: "foo-market",
    version: "1.0.0",
    installed: true,
    enabled: false,
    ...overrides,
  };
}

test("selected installation updates a disabled plugin through its local marketplace", async (t) => {
  const { options, calls } = await fixture(t, [plugin()]);
  await installSelectedPlugins(options);
  deepEqual(calls[0], [
    "codex",
    "plugin",
    "marketplace",
    "add",
    options.marketplaces[0]!.path,
    "--json",
  ]);
  ok(calls.some((call) => call.join(" ") === "codex plugin add foo@foo-market --json"));
});

test("selected installation restores the exact original config bytes", async (t) => {
  const { options, path, contents } = await fixture(t);
  await installSelectedPlugins(options);
  deepEqual(await readFile(path), contents);
  deepEqual(await readdir(options.home), ["config.toml"]);
});

test("selected installation leaves a current disabled plugin installed", async (t) => {
  const { options, calls } = await fixture(t, [plugin({ version: "2.0.0" })]);
  await installSelectedPlugins(options);
  equal(
    calls.some((call) => call[2] === "add"),
    false,
  );
});

test("a native failure restores the config without exposing native output", async (t) => {
  const { options, path, contents, backup } = await fixture(t);
  await rejects(
    installSelectedPlugins({
      ...options,
      run: async (cmd, args, context) => {
        if (args[1] === "add") {
          await writeFile(path, "changed = true\n");
          throw new Error("credential-secret");
        }
        return options.run(cmd, args, context);
      },
    }),
    (error: unknown) => {
      ok(error instanceof Error);
      equal(error.message, "Codex plugin add failed; native output withheld");
      equal(error.cause, undefined);
      doesNotMatch(error.stack ?? "", /credential-secret/);
      return true;
    },
  );
  deepEqual(await readFile(path), contents);
  await rejects(lstat(backup), { code: "ENOENT" });
});

test("an unexpected native version restores the config", async (t) => {
  const { options, path, contents } = await fixture(t);
  await rejects(
    installSelectedPlugins({
      ...options,
      run: async (cmd, args, context) =>
        args[1] === "add"
          ? JSON.stringify({ version: "credential-secret" })
          : options.run(cmd, args, context),
    }),
    (error: unknown) => {
      ok(error instanceof Error);
      match(error.message, /expected foo@foo-market at version 2.0.0/);
      doesNotMatch(error.message, /credential-secret/);
      return true;
    },
  );
  deepEqual(await readFile(path), contents);
});

test("selected installation verifies the final native registry", async (t) => {
  const { options, path, contents } = await fixture(t);
  await rejects(
    installSelectedPlugins({
      ...options,
      run: async (cmd, args, context) =>
        args[1] === "add" ? JSON.stringify({ version: "2.0.0" }) : options.run(cmd, args, context),
    }),
    /registry does not contain foo@foo-market at version 2.0.0/,
  );
  deepEqual(await readFile(path), contents);
});

test("an unexpected marketplace stops plugin installation", async (t) => {
  const { options, path, contents, calls } = await fixture(t);
  await rejects(
    installSelectedPlugins({
      ...options,
      run: async (cmd, args) => {
        calls.push([cmd, ...args]);
        return JSON.stringify({ marketplaceName: "unexpected" });
      },
    }),
    /expected foo-market/,
  );
  equal(calls.length, 1);
  deepEqual(await readFile(path), contents);
});

test("selected installation protects its recovery snapshot from other users", async (t) => {
  const { options, backup, contents } = await fixture(t);
  await installSelectedPlugins({
    ...options,
    run: async (cmd, args, context) => {
      equal((await lstat(backup)).mode & 0o777, 0o600);
      deepEqual(await readFile(backup), contents);
      return options.run(cmd, args, context);
    },
  });
});

test("a recovery snapshot blocks another installation before native commands", async (t) => {
  const { options, backup, calls } = await fixture(t);
  await writeFile(backup, "recover-me", { mode: 0o600 });
  await rejects(installSelectedPlugins(options), /requires recovery/);
  deepEqual(calls, []);
  equal(await readFile(backup, "utf8"), "recover-me");
});

test("a failed config restoration preserves the private recovery snapshot", async (t) => {
  const { options, path, backup, contents } = await fixture(t);
  await rejects(
    installSelectedPlugins({
      ...options,
      run: async () => {
        await rm(path);
        await mkdir(path);
        throw new Error("credential-secret");
      },
    }),
    (error: unknown) => {
      ok(error instanceof Error);
      match(error.message, /config restoration failed; recover the private backup/);
      ok(error.message.includes(backup));
      equal(error.cause, undefined);
      return true;
    },
  );
  deepEqual(await readFile(backup), contents);
  equal((await lstat(backup)).mode & 0o777, 0o600);
});

test("a linked config is rejected before native commands", async (t) => {
  const { options, path, calls } = await fixture(t);
  const target = join(options.home, "source.toml");
  await writeFile(target, "source = true\n");
  await rm(path);
  await symlink(target, path);
  await rejects(installSelectedPlugins(options), /regular config.toml file/);
  deepEqual(calls, []);
  equal(await readFile(target, "utf8"), "source = true\n");
});

test("plugin inventory uses the requested scope without exposing extra native fields", async () => {
  const calls: Array<Parameters<CommandRunner>> = [];
  const run: CommandRunner = async (...args) => {
    calls.push(args);
    return JSON.stringify({
      installed: [{ ...plugin(), transport: { secret: "credential-secret" } }],
      available: [plugin({ name: "available", installed: false })],
    });
  };
  deepEqual(await listCodexPlugins({ home: "state", cwd: "project/nested", run }), [plugin()]);
  deepEqual(calls, [
    [
      "codex",
      ["plugin", "list", "--json"],
      { env: { CODEX_HOME: resolve("state") }, cwd: resolve("project/nested") },
    ],
  ]);
});

test("MCP inventory returns only names and enablement", async () => {
  const run: CommandRunner = async (cmd, args, context) => {
    equal(cmd, "codex");
    deepEqual(args, ["mcp", "list", "--json"]);
    equal(context?.cwd, resolve("project/nested"));
    return JSON.stringify([
      { name: "enabled", enabled: true, transport: { env: { TOKEN: "credential-secret" } } },
      { name: "disabled", enabled: false, auth_status: "unsupported" },
    ]);
  };
  deepEqual(await listCodexMcp({ home: "state", cwd: "project/nested", run }), [
    { name: "enabled", enabled: true },
    { name: "disabled", enabled: false },
  ]);
});

test("malformed MCP output is rejected without exposing its contents", async () => {
  await rejects(
    listCodexMcp({
      home: "state",
      cwd: "/",
      run: async () => JSON.stringify([{ name: "credential-secret", enabled: "invalid" }]),
    }),
    (error: unknown) => {
      ok(error instanceof Error);
      equal(error.message, "Codex MCP list did not return the expected native JSON");
      equal(error.cause, undefined);
      return true;
    },
  );
});

test("malformed plugin output is rejected without exposing its contents", async () => {
  await rejects(
    listCodexPlugins({ home: "state", cwd: "/", run: async () => "credential-secret" }),
    (error: unknown) => {
      ok(error instanceof Error);
      equal(error.message, "Codex plugin list did not return the expected native JSON");
      equal(error.cause, undefined);
      return true;
    },
  );
});
