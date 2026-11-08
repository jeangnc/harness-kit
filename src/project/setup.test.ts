import { deepEqual, equal, ok, rejects } from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { parse, stringify } from "smol-toml";
import type { CommandRunner } from "../install/runner.js";
import {
  enrollProject,
  locateProject,
  prepareProject,
  selectProject,
  setupProject,
} from "./index.js";
import {
  appPlugin,
  createFixture,
  createNativeRuntime,
  isPluginInstall,
  leafPlugin,
  nestedPlugin,
  pluginEnabled,
  prepareFixture,
  rootPlugin,
  snapshot,
  writeProjectConfig,
  type Inventory,
} from "./fixtures.testutil.js";

test("Nested plugin settings survive native installer configuration rewrites", async (t) => {
  const fixture = await createFixture(t);
  const nested = join(fixture.project, "bar");
  const deeper = join(nested, "baz");
  writeProjectConfig(
    fixture.project,
    `[plugins]\n"${appPlugin}".enabled = true\n"${nestedPlugin}".enabled = false\n\n[mcp_servers.foo]\ncommand = "node"\nenabled = false\n`,
  );
  writeProjectConfig(
    nested,
    `[plugins]\n"${appPlugin}".enabled = false\n"${nestedPlugin}".enabled = true\n\n[mcp_servers.foo]\nenabled = true\n`,
  );
  writeProjectConfig(
    deeper,
    `[plugins]\n"${nestedPlugin}".enabled = false\n"${leafPlugin}".enabled = true\n`,
  );
  const paths = [fixture.project, nested, deeper].map((cwd) => join(cwd, ".codex/config.toml"));
  const before = paths.map((path) => readFileSync(path, "utf8"));
  const native = createNativeRuntime(fixture);
  const plan = await prepareFixture(fixture);

  const result = await setupProject(plan, native.run);

  deepEqual(native.installedPlugins(), [leafPlugin, appPlugin, nestedPlugin, rootPlugin]);
  deepEqual(result.scopes, [
    { path: ".", plugins: [appPlugin, rootPlugin], mcp: [] },
    { path: "bar", plugins: [nestedPlugin, rootPlugin], mcp: ["foo"] },
    { path: "bar/baz", plugins: [leafPlugin, rootPlugin], mcp: ["foo"] },
  ]);
  const homeConfig = parse(readFileSync(join(plan.home, "config.toml"), "utf8"));
  equal(pluginEnabled(homeConfig, appPlugin), false);
  equal(pluginEnabled(homeConfig, nestedPlugin), false);
  equal(pluginEnabled(homeConfig, leafPlugin), false);
  ok(native.writtenConfigs.some((config) => pluginEnabled(config, nestedPlugin)));
  deepEqual(
    paths.map((path) => readFileSync(path, "utf8")),
    before,
  );
});

test("Repeated setup preserves user configuration, instructions, credentials, history, and environment bytes", async (t) => {
  const fixture = await createFixture(t);
  writeProjectConfig(fixture.project, `[plugins]\n"${appPlugin}".enabled = true\n`);
  const originalEnvrc = "export FOO='bar'\n";
  writeFileSync(join(fixture.project, ".envrc"), originalEnvrc);
  const native = createNativeRuntime(fixture);
  const plan = await prepareFixture(fixture);
  await setupProject(plan, native.run);
  equal(readFileSync(join(plan.home, "AGENTS.md"), "utf8"), fixture.preset.instructions);
  await enrollProject(plan, native.run);
  const configPath = join(plan.home, "config.toml");
  writeFileSync(
    configPath,
    `model = "foo"\n\n# Retain this formatting.\n${readFileSync(configPath, "utf8")}\n`,
  );
  const personalFiles = {
    "AGENTS.md": "Use the project's domain terms.\n",
    "auth.json": '{"tokens":{"access_token":"foo"}}\n',
    ".credentials.json": '{"foo":{"access_token":"bar"}}\n',
    "history.jsonl": '{"session_id":"foo","text":"bar"}\n',
    "sessions/foo.jsonl": '{"type":"foo"}\n',
  };
  for (const [path, contents] of Object.entries(personalFiles)) {
    mkdirSync(dirname(join(plan.home, path)), { recursive: true });
    writeFileSync(join(plan.home, path), contents);
  }
  const paths = [
    configPath,
    join(fixture.project, ".envrc"),
    ...Object.keys(personalFiles).map((path) => join(plan.home, path)),
  ];
  const before = paths.map((path) => readFileSync(path, "utf8"));
  const installsBefore = native.calls.filter(isPluginInstall).length;
  const rewritesBefore = native.writtenConfigs.length;

  const resumed = await prepareProject({ location: plan }, fixture.run);
  const result = await setupProject(resumed, native.run);
  await enrollProject(resumed, native.run);

  equal(result.status, "ready");
  deepEqual(
    paths.map((path) => readFileSync(path, "utf8")),
    before,
  );
  equal(native.calls.filter(isPluginInstall).length, installsBefore);
  ok(native.writtenConfigs.length > rewritesBefore);
  const exclude = (
    await fixture.run("git", ["rev-parse", "--git-path", "info/exclude"], { cwd: fixture.project })
  ).trim();
  equal(
    readFileSync(resolve(fixture.project, exclude), "utf8")
      .split("\n")
      .filter((line) => line === "/.envrc").length,
    1,
  );
  equal(
    native.calls.some(({ program }) => program === "direnv"),
    false,
  );
});

test("Failed native installation restores configuration before setup resumes", async (t) => {
  const fixture = await createFixture(t);
  writeProjectConfig(fixture.project, `[plugins]\n"${nestedPlugin}".enabled = true\n`);
  const native = createNativeRuntime(fixture, { failPlugin: rootPlugin });
  const plan = await prepareFixture(fixture);

  await rejects(setupProject(plan, native.run), /Codex plugin add failed/);

  equal(readFileSync(join(plan.home, "config.toml"), "utf8"), stringify(plan.config));
  await rejects(selectProject(fixture, fixture.run), /not ready/i);
  equal(existsSync(join(fixture.project, ".envrc")), false);

  const result = await setupProject(await prepareFixture(fixture), native.run);

  equal(result.status, "ready");
  deepEqual(result.scopes[0]!.plugins, [nestedPlugin, rootPlugin]);
  equal(
    native.calls.filter((call) => isPluginInstall(call) && call.args[2] === nestedPlugin).length,
    1,
  );
  equal(
    native.calls.filter((call) => isPluginInstall(call) && call.args[2] === rootPlugin).length,
    2,
  );
  equal(await selectProject(fixture, fixture.run), plan.home);
});

test("A missing enabled plugin prevents the home from becoming ready", async (t) => {
  const fixture = await createFixture(t);
  writeProjectConfig(fixture.project, `[plugins]\n"${appPlugin}".enabled = true\n`);
  const native = createNativeRuntime(fixture);
  const plan = await prepareFixture(fixture);
  const run: CommandRunner = async (program, args, options) => {
    const output = await native.run(program, args, options);
    if (
      program !== "codex" ||
      args[0] !== "plugin" ||
      args[1] !== "list" ||
      options?.cwd !== fixture.project
    ) {
      return output;
    }
    ok(typeof output === "string");
    const inventory = JSON.parse(output) as Inventory;
    inventory.installed.find(({ name }) => name === "bar")!.enabled = false;
    return JSON.stringify(inventory);
  };

  await rejects(setupProject(plan, run), /Enabled plugin inventory differs/i);

  await rejects(selectProject(fixture, fixture.run), /not ready/i);
  equal(existsSync(join(fixture.project, ".envrc")), false);
});

test("An unrecognized existing home is rejected without changing its contents", async (t) => {
  const fixture = await createFixture(t);
  const location = await locateProject(fixture, fixture.run);
  mkdirSync(location.home, { recursive: true });
  writeFileSync(join(location.home, "auth.json"), '{"token":"foo"}\n');
  const before = snapshot(location.home);

  await rejects(
    prepareProject({ location, preset: fixture.preset }, fixture.run),
    /unrecognized home/i,
  );

  deepEqual(snapshot(location.home), before);
});

test("A checkout with an occupied basename cannot select another checkout's home", async (t) => {
  const first = await createFixture(t);
  const second = await createFixture(t);
  const plan = await prepareFixture(first);
  await setupProject(plan, createNativeRuntime(first).run);
  const before = snapshot(first.stateRoot);

  await rejects(
    selectProject({ project: second.project, stateRoot: first.stateRoot }, second.run),
    /home identity conflicts/i,
  );

  deepEqual(snapshot(first.stateRoot), before);
});

test("A stale setup plan cannot claim another checkout's home", async (t) => {
  const first = await createFixture(t);
  const second = await createFixture(t);
  const plan = await prepareFixture(first);
  const location = await locateProject(
    { project: second.project, stateRoot: first.stateRoot },
    second.run,
  );
  const stale = await prepareProject({ location, preset: second.preset }, second.run);
  const native = createNativeRuntime(first);
  await setupProject(plan, native.run);
  const before = snapshot(first.stateRoot);
  const calls = native.calls.length;

  await rejects(setupProject(stale, native.run), /home identity conflicts/i);

  deepEqual(snapshot(first.stateRoot), before);
  equal(native.calls.length, calls);
  equal(await selectProject(first, first.run), plan.home);
});

test("A stale setup plan cannot replace an existing preset", async (t) => {
  const fixture = await createFixture(t);
  const plan = await prepareFixture(fixture);
  const stale = await prepareProject(
    { location: plan, preset: { ...fixture.preset, name: "bar" } },
    fixture.run,
  );
  const native = createNativeRuntime(fixture);
  await setupProject(plan, native.run);
  const before = snapshot(fixture.stateRoot);
  const calls = native.calls.length;

  await rejects(setupProject(stale, native.run), /refusing to replace its harness/i);

  deepEqual(snapshot(fixture.stateRoot), before);
  equal(native.calls.length, calls);
});

test("A stale setup plan cannot adopt a home created after preparation", async (t) => {
  const fixture = await createFixture(t);
  const plan = await prepareFixture(fixture);
  mkdirSync(plan.home, { recursive: true });
  const before = snapshot(fixture.stateRoot);
  const native = createNativeRuntime(fixture);

  await rejects(setupProject(plan, native.run), /unrecognized home/i);

  deepEqual(snapshot(fixture.stateRoot), before);
  equal(native.calls.length, 0);
});

test("A symlinked home is rejected without changing its target", async (t) => {
  const fixture = await createFixture(t);
  const location = await locateProject(fixture, fixture.run);
  const foreign = join(fixture.root, "foreign");
  mkdirSync(foreign);
  writeFileSync(join(foreign, "auth.json"), '{"token":"foo"}\n');
  mkdirSync(fixture.stateRoot);
  symlinkSync(foreign, location.home);
  const before = snapshot(foreign);

  await rejects(
    prepareProject({ location, preset: fixture.preset }, fixture.run),
    /regular directory/i,
  );

  deepEqual(snapshot(foreign), before);
  equal(lstatSync(location.home).isSymbolicLink(), true);
});
