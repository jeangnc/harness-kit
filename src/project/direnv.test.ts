import { deepEqual, equal, ok, rejects } from "node:assert/strict";
import { existsSync, lstatSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { enrollProject, setupProject, verifyProject } from "./index.js";
import {
  createFixture,
  createNativeRuntime,
  prepareFixture,
  rootPlugin,
  trustedHooks,
} from "./fixtures.testutil.js";

test("Enrollment selects the project home when paths contain spaces and quotes", async (t) => {
  const fixture = await createFixture(t, {
    projectName: "foo's project",
    stateName: "bar's state",
  });
  const native = createNativeRuntime(fixture);
  const plan = await prepareFixture(fixture);

  const result = await setupProject(plan, native.run);
  equal(existsSync(join(fixture.project, ".envrc")), false);
  await enrollProject(plan, native.run);
  equal(
    native.calls.some(({ program }) => program === "direnv"),
    false,
  );
  await fixture.run("direnv", ["allow", fixture.project]);
  const verified = await verifyProject(await prepareFixture(fixture), {
    environment: "direnv",
    run: native.run,
    inspectHooks: trustedHooks,
  });

  equal(result.status, "ready");
  equal(verified.status, "verified");
  equal(verified.home, plan.home);
  deepEqual(result.scopes, [{ path: ".", plugins: [rootPlugin], mcp: [] }]);
  equal(
    (
      await fixture.run("direnv", [
        "exec",
        fixture.project,
        process.execPath,
        "-e",
        "process.stdout.write(process.env.CODEX_HOME || '')",
      ])
    ).trim(),
    plan.home,
  );
  ok(
    native.calls
      .filter(({ program }) => program === "codex")
      .every(({ home }) => home === plan.home),
  );
});

test("Directory entry selects the prepared home without Node on PATH", async (t) => {
  const fixture = await createFixture(t);
  const native = createNativeRuntime(fixture);
  const plan = await prepareFixture(fixture);
  await setupProject(plan, native.run);
  await enrollProject(plan, native.run);
  await fixture.run("direnv", ["allow", fixture.project]);
  const direnv = (await fixture.run("which", ["direnv"])).trim();

  const home = await fixture.run(
    direnv,
    ["exec", fixture.project, "/bin/sh", "-c", 'printf %s "$CODEX_HOME"'],
    { env: { PATH: "/usr/bin:/bin" } },
  );

  equal(home, plan.home);
});

test("Enrollment writes a tilde path for a home inside the user directory", async (t) => {
  const fixture = await createFixture(t);
  const userHome = join(fixture.root, "user");
  const stateRoot = join(userHome, ".codex", "projects");
  const native = createNativeRuntime(fixture);
  const plan = await prepareFixture({ ...fixture, stateRoot });
  await setupProject(plan, native.run);

  await fixture.run(process.execPath, [
    "--import",
    "tsx",
    fileURLToPath(new URL("../cli.ts", import.meta.url)),
    "project",
    "enroll",
    "--project",
    fixture.project,
    "--state-root",
    stateRoot,
  ]);
  await fixture.run("direnv", ["allow", fixture.project]);
  const home = await fixture.run("direnv", [
    "exec",
    fixture.project,
    "/bin/sh",
    "-c",
    'printf %s "$CODEX_HOME"',
  ]);

  equal(
    readFileSync(join(fixture.project, ".envrc"), "utf8"),
    `export CODEX_HOME=~/${relative(userHome, plan.home)}\n`,
  );
  equal(home, plan.home);
});

test("Enrollment preserves literal shell characters in a home-relative path", async (t) => {
  const fixture = await createFixture(t, { projectName: "foo's $bar $(touch baz)" });
  const stateRoot = join(fixture.root, "user", ".codex", "projects");
  const native = createNativeRuntime(fixture);
  const plan = await prepareFixture({ ...fixture, stateRoot });
  await setupProject(plan, native.run);

  await fixture.run(process.execPath, [
    "--import",
    "tsx",
    fileURLToPath(new URL("../cli.ts", import.meta.url)),
    "project",
    "enroll",
    "--project",
    fixture.project,
    "--state-root",
    stateRoot,
  ]);
  await fixture.run("direnv", ["allow", fixture.project]);
  const home = await fixture.run("direnv", [
    "exec",
    fixture.project,
    "/bin/sh",
    "-c",
    'printf %s "$CODEX_HOME"',
  ]);

  equal(home, plan.home);
  equal(existsSync(join(fixture.project, "baz")), false);
});

test("Enrollment rejects a symlinked environment file without changing its target", async (t) => {
  const fixture = await createFixture(t);
  const native = createNativeRuntime(fixture);
  const plan = await prepareFixture(fixture);
  await setupProject(plan, native.run);
  const foreign = join(fixture.root, "foreign.envrc");
  const contents = "export FOO=bar\n";
  writeFileSync(foreign, contents);
  symlinkSync(foreign, join(fixture.project, ".envrc"));

  await rejects(enrollProject(plan, native.run), /regular file/i);

  equal(readFileSync(foreign, "utf8"), contents);
  equal(lstatSync(join(fixture.project, ".envrc")).isSymbolicLink(), true);
});

test("Enrollment rejects an existing Codex environment selection without changing it", async (t) => {
  const fixture = await createFixture(t);
  const native = createNativeRuntime(fixture);
  const plan = await prepareFixture(fixture);
  await setupProject(plan, native.run);
  const contents = "export CODEX_HOME='/foo/bar'\n";
  writeFileSync(join(fixture.project, ".envrc"), contents);

  await rejects(enrollProject(plan, native.run), /environment selection conflicts/i);

  equal(readFileSync(join(fixture.project, ".envrc"), "utf8"), contents);
});

test("Enrollment rejects a commented selection without reporting success", async (t) => {
  const fixture = await createFixture(t);
  const native = createNativeRuntime(fixture);
  const plan = await prepareFixture(fixture);
  await setupProject(plan, native.run);
  const contents = `# export CODEX_HOME='${plan.home}'\n`;
  writeFileSync(join(fixture.project, ".envrc"), contents);

  await rejects(enrollProject(plan, native.run), /environment selection conflicts/i);

  equal(readFileSync(join(fixture.project, ".envrc"), "utf8"), contents);
});
