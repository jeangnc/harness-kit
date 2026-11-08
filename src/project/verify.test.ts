import { deepEqual, ok, rejects } from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import type { CommandRunner } from "../install/runner.js";
import type { CodexPluginEntry } from "../vendors/codex/native.js";
import { setupProject, verifyProject } from "./index.js";
import {
  createFixture,
  createNativeRuntime,
  nestedPlugin,
  prepareFixture,
  rootPlugin,
  trustedHooks,
  writeProjectConfig,
  type Inventory,
} from "./fixtures.testutil.js";

test("Verification reports enabled remote account plugins alongside the configured local plugins", async (t) => {
  const fixture = await createFixture(t);
  const native = createNativeRuntime(fixture);
  const plan = await prepareFixture(fixture);
  const remote: CodexPluginEntry = {
    name: "bar",
    marketplaceName: "bar",
    version: "1.0.0",
    installed: true,
    enabled: true,
    source: { source: "remote" },
  };
  const run = withInstalledPlugins(native.run, (installed) => [...installed, remote]);
  await setupProject(plan, run);

  const result = await verifyProject(plan, {
    environment: "none",
    run,
    inspectHooks: trustedHooks,
  });

  deepEqual(result.scopes, [{ path: ".", plugins: ["bar@bar", rootPlugin], mcp: [] }]);
});

function withInstalledPlugins(
  run: CommandRunner,
  select: (plugins: readonly CodexPluginEntry[]) => readonly CodexPluginEntry[],
): CommandRunner {
  return async (program, args, options) => {
    const output = await run(program, args, options);
    if (program !== "codex" || args[0] !== "plugin" || args[1] !== "list") return output;
    ok(typeof output === "string");
    const inventory = JSON.parse(output) as Inventory;
    return JSON.stringify({ ...inventory, installed: select(inventory.installed) });
  };
}

test("Verification rejects enabled local plugins absent from the configuration", async (t) => {
  const fixture = await createFixture(t);
  const native = createNativeRuntime(fixture);
  const plan = await prepareFixture(fixture);
  await setupProject(plan, native.run);
  const foreign: CodexPluginEntry = {
    name: "bar",
    marketplaceName: "bar",
    version: "1.0.0",
    installed: true,
    enabled: true,
    source: { source: "local" },
  };
  const run = withInstalledPlugins(native.run, (installed) => [...installed, foreign]);

  await rejects(
    verifyProject(plan, { environment: "none", run, inspectHooks: trustedHooks }),
    /Enabled plugin inventory differs/i,
  );
});

test("Verification rejects a remote plugin that replaces a configured local plugin", async (t) => {
  const fixture = await createFixture(t);
  const native = createNativeRuntime(fixture);
  const plan = await prepareFixture(fixture);
  await setupProject(plan, native.run);
  const run = withInstalledPlugins(native.run, (installed) =>
    installed.map((entry) => ({ ...entry, source: { source: "remote" } })),
  );

  await rejects(
    verifyProject(plan, { environment: "none", run, inspectHooks: trustedHooks }),
    /Enabled plugin inventory differs/i,
  );
});

test("Verification rejects a missing configured MCP server", async (t) => {
  const fixture = await createFixture(t);
  writeProjectConfig(fixture.project, '[mcp_servers.foo]\ncommand = "node"\n');
  const native = createNativeRuntime(fixture);
  await setupProject(await prepareFixture(fixture), native.run);
  const run: CommandRunner = async (program, args, options) => {
    if (program === "codex" && args[0] === "mcp" && args[1] === "list") return "[]";
    return native.run(program, args, options);
  };

  await rejects(
    verifyProject(await prepareFixture(fixture), {
      environment: "none",
      run,
      inspectHooks: trustedHooks,
    }),
    /MCP foo is missing/i,
  );
});

test("Verification rejects enabled hooks whose approval is pending", async (t) => {
  const fixture = await createFixture(t);
  const native = createNativeRuntime(fixture);
  await setupProject(await prepareFixture(fixture), native.run);

  await rejects(
    verifyProject(await prepareFixture(fixture), {
      environment: "none",
      run: native.run,
      inspectHooks: async () => [{ cwd: fixture.project, trusted: 1, pending: ["foo"] }],
    }),
    /Hook approval is pending/i,
  );
});

test("Verification checks direnv selection in every configured scope", async (t) => {
  const fixture = await createFixture(t);
  const nested = join(fixture.project, "bar");
  writeProjectConfig(nested, `[plugins]\n"${nestedPlugin}".enabled = true\n`);
  const native = createNativeRuntime(fixture);
  const plan = await prepareFixture(fixture);
  await setupProject(plan, native.run);
  const selections: string[] = [];
  const run: CommandRunner = async (program, args, options) => {
    if (program === "direnv" && args[0] === "exec") {
      const cwd = args[1]!;
      selections.push(cwd);
      return cwd === nested ? join(fixture.root, "foreign") : plan.home;
    }
    return native.run(program, args, options);
  };

  await rejects(
    verifyProject(plan, { environment: "direnv", run, inspectHooks: trustedHooks }),
    /direnv selected a different home/i,
  );

  deepEqual(selections, [fixture.project, nested]);
});
