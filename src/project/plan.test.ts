import { deepEqual, equal, rejects } from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { parse } from "smol-toml";
import { locateProject, prepareProject, setupProject } from "./index.js";
import {
  appPlugin,
  createFixture,
  createNativeRuntime,
  leafPlugin,
  nestedPlugin,
  pluginEnabled,
  prepareFixture,
  rootPlugin,
  snapshot,
  writeProjectConfig,
} from "./fixtures.testutil.js";

test("Preparation describes nested plugins without changing the filesystem", async (t) => {
  const fixture = await createFixture(t);
  writeProjectConfig(fixture.project, `[plugins]\n"${appPlugin}".enabled = true\n`);
  writeProjectConfig(join(fixture.project, "bar"), `[plugins]\n"${nestedPlugin}".enabled = true\n`);
  const before = snapshot(fixture.root);

  const plan = await prepareFixture(fixture);

  equal(plan.project, fixture.project);
  equal(plan.preset, "foo");
  deepEqual(plan.plugins, [appPlugin, nestedPlugin, rootPlugin]);
  deepEqual(
    plan.scopes.map(({ cwd }) => cwd),
    [fixture.project, join(fixture.project, "bar")],
  );
  deepEqual(snapshot(fixture.root), before);
  equal(existsSync(fixture.stateRoot), false);
});

for (const projectName of ["tmp", "dist", "vendor"]) {
  test(`Preparation includes the root config in a checkout named ${projectName}`, async (t) => {
    const fixture = await createFixture(t, { projectName });
    writeProjectConfig(
      fixture.project,
      `[plugins]\n"${rootPlugin}".enabled = false\n"${nestedPlugin}".enabled = true\n`,
    );

    const plan = await prepareFixture(fixture);

    deepEqual(plan.plugins, [nestedPlugin]);
    deepEqual(
      plan.configFiles.map(({ path }) => path),
      [join(fixture.project, ".codex/config.toml")],
    );
  });
}

for (const directory of ["vendor", "dist", "tmp"]) {
  test(`Preparation includes a nested config in a ${directory} directory`, async (t) => {
    const fixture = await createFixture(t);
    const nested = join(fixture.project, directory);
    writeProjectConfig(nested, `[plugins]\n"${nestedPlugin}".enabled = true\n`);

    const plan = await prepareFixture(fixture);

    deepEqual(plan.plugins, [nestedPlugin, rootPlugin]);
    deepEqual(
      plan.scopes.map(({ cwd }) => cwd),
      [fixture.project, nested],
    );
  });
}

test("Preparation excludes configs in Git metadata", async (t) => {
  const fixture = await createFixture(t);
  writeProjectConfig(
    join(fixture.project, ".git"),
    `[plugins]\n"${nestedPlugin}".enabled = true\n`,
  );

  const plan = await prepareFixture(fixture);

  deepEqual(plan.configFiles, []);
  deepEqual(plan.plugins, [rootPlugin]);
});

test("Preparation excludes configs owned by a nested repository", async (t) => {
  const fixture = await createFixture(t);
  const nested = join(fixture.project, "bar");
  await fixture.run("git", ["init", "--quiet", nested]);
  writeProjectConfig(nested, `[plugins]\n"${nestedPlugin}".enabled = true\n`);

  const plan = await prepareFixture(fixture);

  deepEqual(plan.configFiles, []);
  deepEqual(plan.plugins, [rootPlugin]);
});

test("Preparation excludes configs owned by a stale nested worktree", async (t) => {
  const fixture = await createFixture(t);
  const nested = join(fixture.project, "bar");
  writeProjectConfig(nested, `[plugins]\n"${nestedPlugin}".enabled = true\n`);
  writeProjectConfig(join(nested, "src"), `[plugins]\n"${leafPlugin}".enabled = true\n`);
  writeFileSync(join(nested, ".git"), "gitdir: missing\n");

  const plan = await prepareFixture(fixture);

  deepEqual(plan.configFiles, []);
  deepEqual(plan.plugins, [rootPlugin]);
});

test("Relative marketplace paths persist as canonical sources across working directories", async (t) => {
  const fixture = await createFixture(t);
  const native = createNativeRuntime(fixture);
  const location = await locateProject(fixture, fixture.run);
  const preset = {
    ...fixture.preset,
    marketplaces: fixture.preset.marketplaces.map((marketplace) => ({
      ...marketplace,
      path: relative(process.cwd(), marketplace.path),
    })),
  };

  const plan = await prepareProject({ location, preset }, fixture.run);
  await setupProject(plan, native.run);

  deepEqual(plan.marketplaces, fixture.preset.marketplaces);
  const expectedSources = Object.fromEntries(
    fixture.preset.marketplaces.map(({ name, path }) => [
      name,
      { source_type: "local", source: path },
    ]),
  );
  deepEqual(plan.config["marketplaces"], expectedSources);
  deepEqual(
    parse(readFileSync(join(plan.home, "config.toml"), "utf8"))["marketplaces"],
    expectedSources,
  );
  deepEqual(JSON.parse(readFileSync(join(plan.home, "project.json"), "utf8")), {
    version: 1,
    project: plan.project,
    preset: preset.name,
    marketplaces: fixture.preset.marketplaces,
  });
  const previous = process.cwd();
  try {
    process.chdir(fixture.project);
    deepEqual(
      (await prepareProject({ location }, fixture.run)).marketplaces,
      fixture.preset.marketplaces,
    );
  } finally {
    process.chdir(previous);
  }
});

test("A preset enables only its selected catalog plugins", async (t) => {
  const fixture = await createFixture(t);

  const plan = await prepareFixture(fixture);

  deepEqual(plan.plugins, [rootPlugin]);
  equal(pluginEnabled(plan.config, appPlugin), false);
  equal(pluginEnabled(plan.config, nestedPlugin), false);
  equal(pluginEnabled(plan.config, leafPlugin), false);
  equal(plan.config["cli_auth_credentials_store"], "file");
  equal(plan.config["mcp_oauth_credentials_store"], "file");
});

test("An empty preset leaves credential storage and trust policy to its caller", async (t) => {
  const fixture = await createFixture(t);
  const location = await locateProject(fixture, fixture.run);

  const plan = await prepareProject(
    { location, preset: { ...fixture.preset, config: {} } },
    fixture.run,
  );

  equal(plan.config["cli_auth_credentials_store"], undefined);
  equal(plan.config["mcp_oauth_credentials_store"], undefined);
  equal(plan.config["projects"], undefined);
  deepEqual(plan.plugins, []);
});

test("An existing project home rejects a different preset", async (t) => {
  const fixture = await createFixture(t);
  const native = createNativeRuntime(fixture);
  const plan = await prepareFixture(fixture);
  await setupProject(plan, native.run);
  const before = snapshot(plan.home);

  await rejects(
    prepareProject({ location: plan, preset: { ...fixture.preset, name: "bar" } }, fixture.run),
    /preset|refusing to replace/i,
  );

  deepEqual(snapshot(plan.home), before);
});
