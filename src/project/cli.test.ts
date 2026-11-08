import { deepEqual } from "node:assert/strict";
import { writeFileSync } from "node:fs";
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
