import { deepEqual, rejects } from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import type { CommandRunner } from "../install/runner.js";
import { setupProject, verifyProject } from "./index.js";
import {
  createFixture,
  createNativeRuntime,
  nestedPlugin,
  prepareFixture,
  trustedHooks,
  writeProjectConfig,
} from "./fixtures.testutil.js";

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
