import { test } from "node:test";
import { deepEqual, equal, fail, match } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  formatPublishError,
  publishBranch,
  publishVendors,
  type PublishOutcome,
  type PublishRequest,
} from "./index.js";
import { layoutAt } from "../layout/index.js";

Object.assign(process.env, {
  GIT_AUTHOR_NAME: "Test Author",
  GIT_AUTHOR_EMAIL: "author@example.com",
  GIT_COMMITTER_NAME: "Test Committer",
  GIT_COMMITTER_EMAIL: "committer@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
});

interface Sandbox {
  readonly request: PublishRequest;
  readonly remoteDir: string;
  readonly writeBuild: (rel: string, content: string) => void;
  readonly source: (...args: readonly string[]) => string;
  readonly remote: (...args: readonly string[]) => string;
}

function run(cwd: string, args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd, encoding: "utf8" }).trim();
}

async function withSandbox<T>(fn: (sandbox: Sandbox) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "harness-publish-test-"));
  const remoteDir = join(root, "remote.git");
  const repoRoot = join(root, "source");
  const buildDir = join(repoRoot, ".harness", "claude");
  run(root, ["init", "-q", "--bare", remoteDir]);
  run(root, ["init", "-q", "-b", "main", repoRoot]);
  writeFileSync(join(repoRoot, ".gitignore"), ".harness/\n");
  writeFileSync(join(repoRoot, "harness.yaml"), "marketplace: demo\n");
  run(repoRoot, ["add", "-A"]);
  run(repoRoot, ["commit", "-q", "-m", "init"]);
  run(repoRoot, ["remote", "add", "origin", remoteDir]);
  mkdirSync(buildDir, { recursive: true });
  const writeBuild = (rel: string, content: string): void => {
    const full = join(buildDir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  };
  const request: PublishRequest = {
    repoRoot,
    buildDir,
    branch: "claude",
    remote: "origin",
    excludedEntries: ["configs"],
  };
  return fn({
    request,
    remoteDir,
    writeBuild,
    source: (...args) => run(repoRoot, args),
    remote: (...args) => run(remoteDir, args),
  }).finally(() => rmSync(root, { recursive: true, force: true }));
}

test("publishBranch creates a parentless commit on the first publish", async () => {
  await withSandbox(async ({ request, writeBuild, remote, source }) => {
    writeBuild("plugins/a/SKILL.md", "a\n");
    const result = await publishBranch(request);
    if (!result.ok) fail(formatPublishError(result.error));
    equal(result.value.kind, "created");
    equal(remote("rev-parse", "refs/heads/claude"), commitOf(result.value));
    equal(remote("rev-list", "--parents", "-n", "1", "claude"), commitOf(result.value));
    equal(remote("log", "-1", "--format=%s", "claude"), `build: ${source("rev-parse", "HEAD")}`);
  });
});

test("publishBranch fast-forwards the branch when the build changes", async () => {
  await withSandbox(async ({ request, writeBuild, remote }) => {
    writeBuild("plugins/a/SKILL.md", "a\n");
    const first = await publishBranch(request);
    if (!first.ok) fail(formatPublishError(first.error));
    writeBuild("plugins/a/SKILL.md", "b\n");
    const second = await publishBranch(request);
    if (!second.ok) fail(formatPublishError(second.error));
    deepEqual(second.value, {
      kind: "advanced",
      branch: "claude",
      commit: remote("rev-parse", "refs/heads/claude"),
      parent: commitOf(first.value),
    });
  });
});

test("publishBranch makes no commit when the build is unchanged", async () => {
  await withSandbox(async ({ request, writeBuild, remote }) => {
    writeBuild("plugins/a/SKILL.md", "a\n");
    const first = await publishBranch(request);
    if (!first.ok) fail(formatPublishError(first.error));
    const second = await publishBranch(request);
    deepEqual(second, {
      ok: true,
      value: { kind: "unchanged", branch: "claude", head: commitOf(first.value) },
    });
    equal(remote("rev-parse", "refs/heads/claude"), commitOf(first.value));
  });
});

test("publishBranch leaves excluded top-level entries out of the published tree", async () => {
  await withSandbox(async ({ request, writeBuild, remote }) => {
    writeBuild("plugins/a/SKILL.md", "a\n");
    writeBuild("configs/settings.json", "{}\n");
    writeBuild("plugins/a/configs/kept.md", "kept\n");
    const result = await publishBranch(request);
    if (!result.ok) fail(formatPublishError(result.error));
    deepEqual(remote("ls-tree", "-r", "--name-only", "claude").split("\n"), [
      "plugins/a/SKILL.md",
      "plugins/a/configs/kept.md",
    ]);
  });
});

test("publishBranch refuses a source repo with uncommitted changes", async () => {
  await withSandbox(async ({ request, writeBuild, remote }) => {
    writeBuild("plugins/a/SKILL.md", "a\n");
    writeFileSync(join(request.repoRoot, "harness.yaml"), "marketplace: changed\n");
    const result = await publishBranch(request);
    deepEqual(result, {
      ok: false,
      error: { kind: "dirty-source", repoRoot: request.repoRoot, paths: ["harness.yaml"] },
    });
    equal(remote("branch", "--list", "claude"), "");
  });
});

test("publishBranch reports a missing build directory", async () => {
  await withSandbox(async ({ request }) => {
    const buildDir = join(request.repoRoot, ".harness", "codex");
    const result = await publishBranch({ ...request, buildDir });
    deepEqual(result, { ok: false, error: { kind: "build-missing", buildDir } });
  });
});

test("publishBranch leaves the source index, worktree, and HEAD untouched", async () => {
  await withSandbox(async ({ request, writeBuild, source }) => {
    writeBuild("plugins/a/SKILL.md", "a\n");
    const head = source("rev-parse", "HEAD");
    const result = await publishBranch(request);
    if (!result.ok) fail(formatPublishError(result.error));
    equal(source("status", "--porcelain"), "");
    equal(source("rev-parse", "HEAD"), head);
    deepEqual(source("ls-files").split("\n"), [".gitignore", "harness.yaml"]);
  });
});

test("publishBranch reports push-rejected when the remote refuses the push", async () => {
  await withSandbox(async ({ request, writeBuild, remoteDir }) => {
    writeBuild("plugins/a/SKILL.md", "a\n");
    const first = await publishBranch(request);
    if (!first.ok) fail(formatPublishError(first.error));
    writeFileSync(
      join(remoteDir, "hooks", "pre-receive"),
      "#!/bin/sh\necho 'branch is protected' >&2\nexit 1\n",
      { mode: 0o755 },
    );
    writeBuild("plugins/a/SKILL.md", "b\n");
    const result = await publishBranch(request);
    if (result.ok) fail(`expected push-rejected, got ${result.value.kind}`);
    equal(result.error.kind, "push-rejected");
    match(formatPublishError(result.error), /branch is protected/);
  });
});

function commitOf(outcome: PublishOutcome): string {
  switch (outcome.kind) {
    case "created":
    case "advanced":
      return outcome.commit;
    case "unchanged":
      return outcome.head;
  }
}

test("publishVendors publishes each vendor build to the branch named after it", async () => {
  await withSandbox(async ({ request, writeBuild, remote }) => {
    writeBuild("plugins/a/SKILL.md", "a\n");
    const codexBuild = join(request.repoRoot, ".harness", "codex", "plugins/a/SKILL.md");
    mkdirSync(dirname(codexBuild), { recursive: true });
    writeFileSync(codexBuild, "codex\n");
    const result = await publishVendors({
      layout: layoutAt(request.repoRoot),
      vendors: ["claude", "codex"],
      remote: "origin",
    });
    if (!result.ok) fail(formatPublishError(result.error));
    deepEqual(
      result.value.map((outcome) => [outcome.kind, outcome.branch]),
      [
        ["created", "claude"],
        ["created", "codex"],
      ],
    );
    equal(remote("show", "codex:plugins/a/SKILL.md"), "codex");
  });
});
