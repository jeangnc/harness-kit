import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { errnoCode } from "../fs.js";
import { git, tryGit } from "../git/index.js";
import { err, ok, type Result } from "../result.js";

export type PublishOutcome =
  | { readonly kind: "created"; readonly branch: string; readonly commit: string }
  | {
      readonly kind: "advanced";
      readonly branch: string;
      readonly commit: string;
      readonly parent: string;
    }
  | { readonly kind: "unchanged"; readonly branch: string; readonly head: string };

export type PublishError =
  | { readonly kind: "dirty-source"; readonly repoRoot: string; readonly paths: readonly string[] }
  | { readonly kind: "build-missing"; readonly buildDir: string }
  | { readonly kind: "push-rejected"; readonly branch: string; readonly detail: string };

export interface PublishRequest {
  readonly repoRoot: string;
  readonly buildDir: string;
  readonly branch: string;
  readonly remote: string;
  readonly excludedEntries: readonly string[];
}

const LS_REMOTE_NO_MATCH = 2;

export function formatPublishError(e: PublishError): string {
  switch (e.kind) {
    case "dirty-source":
      return [
        `refusing to publish: ${e.repoRoot} has uncommitted changes; commit or discard them first:`,
        ...e.paths.map((p) => `  ${p}`),
      ].join("\n");
    case "build-missing":
      return `build directory ${e.buildDir} does not exist; run \`harness build\` first`;
    case "push-rejected":
      return `push to branch '${e.branch}' was rejected: ${e.detail}`;
  }
}

export function formatPublishOutcome(o: PublishOutcome): string {
  switch (o.kind) {
    case "created":
      return `created branch '${o.branch}' at ${short(o.commit)}`;
    case "advanced":
      return `advanced branch '${o.branch}' ${short(o.parent)}..${short(o.commit)}`;
    case "unchanged":
      return `branch '${o.branch}' unchanged at ${short(o.head)}`;
  }
}

function short(sha: string): string {
  return sha.slice(0, 7);
}

export async function publishBranch(
  request: PublishRequest,
): Promise<Result<PublishOutcome, PublishError>> {
  const { repoRoot, buildDir, branch, remote } = request;
  const dirty = await dirtyPaths(repoRoot);
  if (dirty.length > 0) return err({ kind: "dirty-source", repoRoot, paths: dirty });
  if (!(await isDirectory(buildDir))) return err({ kind: "build-missing", buildDir });

  const parent = await fetchBranchHead(repoRoot, remote, branch);
  const tree = await writeBuildTree(request);
  if (parent !== null && (await treeOf(repoRoot, parent)) === tree) {
    return ok({ kind: "unchanged", branch, head: parent });
  }

  const commit = await commitTree(repoRoot, tree, parent);
  const push = await tryGit(["push", "--quiet", remote, `${commit}:refs/heads/${branch}`], {
    cwd: repoRoot,
  });
  if (push.code !== 0) return err({ kind: "push-rejected", branch, detail: push.stderr.trim() });
  if (parent === null) return ok({ kind: "created", branch, commit });
  return ok({ kind: "advanced", branch, commit, parent });
}

async function dirtyPaths(repoRoot: string): Promise<readonly string[]> {
  const status = await git(["status", "--porcelain"], { cwd: repoRoot });
  return status
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => line.slice(3));
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (e) {
    if (errnoCode(e) === "ENOENT") return false;
    throw e;
  }
}

async function fetchBranchHead(
  repoRoot: string,
  remote: string,
  branch: string,
): Promise<string | null> {
  const ref = `refs/heads/${branch}`;
  const listing = await tryGit(["ls-remote", "--exit-code", "--heads", remote, ref], {
    cwd: repoRoot,
  });
  if (listing.code === LS_REMOTE_NO_MATCH) return null;
  if (listing.code !== 0) {
    throw new Error(
      `git ls-remote ${remote} ${ref} in ${repoRoot} exited ${listing.code}, expected 0 or ${LS_REMOTE_NO_MATCH}: ${listing.stderr.trim()}`,
    );
  }
  await git(["fetch", "--quiet", "--no-tags", remote, ref], { cwd: repoRoot });
  return git(["rev-parse", "--verify", "FETCH_HEAD^{commit}"], { cwd: repoRoot });
}

async function writeBuildTree(request: PublishRequest): Promise<string> {
  const gitDir = await git(["rev-parse", "--absolute-git-dir"], { cwd: request.repoRoot });
  const scratch = await mkdtemp(join(tmpdir(), "harness-publish-"));
  const invocation = {
    cwd: request.buildDir,
    env: { GIT_INDEX_FILE: join(scratch, "index") },
  };
  const isolated = [`--git-dir=${gitDir}`, `--work-tree=${request.buildDir}`];
  try {
    await git([...isolated, "add", "-A", "-f", "."], invocation);
    if (request.excludedEntries.length > 0) {
      await git(
        [
          ...isolated,
          "rm",
          "-r",
          "-q",
          "--cached",
          "--ignore-unmatch",
          "--",
          ...request.excludedEntries.map((entry) => `:(top,literal)${entry}`),
        ],
        invocation,
      );
    }
    return await git([...isolated, "write-tree"], invocation);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function treeOf(repoRoot: string, commit: string): Promise<string> {
  return git(["rev-parse", "--verify", `${commit}^{tree}`], { cwd: repoRoot });
}

async function commitTree(repoRoot: string, tree: string, parent: string | null): Promise<string> {
  const source = await git(["rev-parse", "--verify", "HEAD"], { cwd: repoRoot });
  const parentArgs = parent === null ? [] : ["-p", parent];
  return git(["commit-tree", tree, ...parentArgs, "-m", `build: ${source}`], { cwd: repoRoot });
}
