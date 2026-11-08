import { deepEqual, equal } from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { stringify } from "smol-toml";
import { locateProject } from "./index.js";
import {
  createFixture,
  nestedPlugin,
  rootPlugin,
  snapshot,
  writeProjectConfig,
} from "./fixtures.testutil.js";

test("The setup CLI reports a dry run without changing the filesystem", async (t) => {
  const fixture = await createFixture(t, { projectName: "foo's project" });
  writeProjectConfig(join(fixture.project, "bar"), `[plugins]\n"${nestedPlugin}".enabled = true\n`);
  const presetPath = join(fixture.root, "preset.json");
  writeFileSync(
    presetPath,
    JSON.stringify({ ...fixture.preset, config: stringify(fixture.preset.config) }),
  );
  const location = await locateProject(fixture, fixture.run);
  const before = snapshot(fixture.root);

  const output = await fixture.run(process.execPath, [
    "--import",
    "tsx",
    fileURLToPath(new URL("../cli.ts", import.meta.url)),
    "project",
    "setup",
    "--project",
    fixture.project,
    "--state-root",
    fixture.stateRoot,
    "--preset",
    presetPath,
    "--dry-run",
  ]);

  deepEqual(JSON.parse(output), {
    project: fixture.project,
    home: location.home,
    preset: "foo",
    plugins: [nestedPlugin, rootPlugin],
    scopes: [fixture.project, join(fixture.project, "bar")],
  });
  deepEqual(snapshot(fixture.root), before);
});

test("The setup CLI defaults to a readable home under ~/.codex/projects", async (t) => {
  const fixture = await createFixture(t);
  const presetPath = join(fixture.root, "preset.json");
  writeFileSync(
    presetPath,
    JSON.stringify({ ...fixture.preset, config: stringify(fixture.preset.config) }),
  );
  const before = snapshot(fixture.root);

  const output = await fixture.run(process.execPath, [
    "--import",
    "tsx",
    fileURLToPath(new URL("../cli.ts", import.meta.url)),
    "project",
    "setup",
    "--project",
    fixture.project,
    "--preset",
    presetPath,
    "--dry-run",
  ]);

  deepEqual(JSON.parse(output), {
    project: fixture.project,
    home: join(fixture.root, "user", ".codex", "projects", "foo"),
    preset: "foo",
    plugins: [rootPlugin],
    scopes: [fixture.project],
  });
  deepEqual(snapshot(fixture.root), before);
});

test("The setup CLI uses an explicit home name", async (t) => {
  const fixture = await createFixture(t);
  const presetPath = join(fixture.root, "preset.json");
  writeFileSync(
    presetPath,
    JSON.stringify({ ...fixture.preset, config: stringify(fixture.preset.config) }),
  );
  const before = snapshot(fixture.root);

  const output = await fixture.run(process.execPath, [
    "--import",
    "tsx",
    fileURLToPath(new URL("../cli.ts", import.meta.url)),
    "project",
    "setup",
    "--project",
    fixture.project,
    "--state-root",
    fixture.stateRoot,
    "--home-name",
    "bar",
    "--preset",
    presetPath,
    "--dry-run",
  ]);

  deepEqual(JSON.parse(output), {
    project: fixture.project,
    home: join(fixture.stateRoot, "bar"),
    preset: "foo",
    plugins: [rootPlugin],
    scopes: [fixture.project],
  });
  deepEqual(snapshot(fixture.root), before);
});

test("The select CLI reads an explicit home name under the default state root", async (t) => {
  const fixture = await createFixture(t);
  const home = join(fixture.root, "user", ".codex", "projects", "bar");
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, "project.json"),
    JSON.stringify({
      version: 1,
      project: fixture.project,
      preset: fixture.preset.name,
      marketplaces: fixture.preset.marketplaces,
    }),
  );
  writeFileSync(join(home, "ready"), "1\n");
  const before = snapshot(fixture.root);

  const output = await fixture.run(process.execPath, [
    "--import",
    "tsx",
    fileURLToPath(new URL("../cli.ts", import.meta.url)),
    "project",
    "select",
    "--project",
    fixture.project,
    "--home-name",
    "bar",
  ]);

  equal(output, `${home}\n`);
  deepEqual(snapshot(fixture.root), before);
});
