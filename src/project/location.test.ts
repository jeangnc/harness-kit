import { deepEqual, equal, notEqual, rejects } from "node:assert/strict";
import { existsSync, mkdirSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { locateProject } from "./index.js";
import { createFixture, snapshot } from "./fixtures.testutil.js";

test("Linked worktrees with the same directory name receive distinct homes", async (t) => {
  const fixture = await createFixture(t);
  await fixture.run(
    "git",
    [
      "-c",
      "user.name=foo",
      "-c",
      "user.email=foo@example.test",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      "foo",
    ],
    { cwd: fixture.project },
  );
  const worktree = join(fixture.root, "worktrees", "foo");
  await fixture.run("git", ["worktree", "add", "--quiet", "-b", "bar", worktree], {
    cwd: fixture.project,
  });
  const nested = join(fixture.project, "nested");
  mkdirSync(nested);

  const primary = await locateProject(
    { project: fixture.project, stateRoot: fixture.stateRoot },
    fixture.run,
  );
  const linked = await locateProject(
    { project: worktree, stateRoot: fixture.stateRoot },
    fixture.run,
  );

  equal(primary.project, fixture.project);
  equal(linked.project, worktree);
  notEqual(primary.home, linked.home);
  equal(dirname(primary.home), fixture.stateRoot);
  equal(dirname(linked.home), fixture.stateRoot);
  deepEqual(
    await locateProject({ project: nested, stateRoot: fixture.stateRoot }, fixture.run),
    primary,
  );
  equal(existsSync(fixture.stateRoot), false);
});

test("A state root under a checkout symlink is rejected before writes", async (t) => {
  const fixture = await createFixture(t);
  const alias = join(fixture.root, "checkout-alias");
  symlinkSync(fixture.project, alias);
  const stateRoot = join(alias, "missing", "state");
  const before = snapshot(fixture.root);

  await rejects(
    locateProject({ project: fixture.project, stateRoot }, fixture.run),
    /state must live outside the project/i,
  );

  deepEqual(snapshot(fixture.root), before);
  equal(existsSync(join(fixture.project, "missing")), false);
});

test("A state root under an external symlink has its canonical home identity", async (t) => {
  const fixture = await createFixture(t);
  const external = join(fixture.root, "external");
  const alias = join(fixture.root, "external-alias");
  mkdirSync(external);
  symlinkSync(external, alias);
  const stateRoot = join(external, "missing", "state");
  const before = snapshot(fixture.root);

  const canonical = await locateProject({ project: fixture.project, stateRoot }, fixture.run);
  const throughAlias = await locateProject(
    { project: fixture.project, stateRoot: join(alias, "missing", "state") },
    fixture.run,
  );

  deepEqual(throughAlias, canonical);
  equal(throughAlias.stateRoot, stateRoot);
  equal(dirname(throughAlias.home), stateRoot);
  deepEqual(snapshot(fixture.root), before);
});
