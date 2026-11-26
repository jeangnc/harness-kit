import { test } from "node:test";
import { equal, match, notEqual, ok } from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const cliPath = fileURLToPath(new URL("./cli.ts", import.meta.url));
const pkgPath = fileURLToPath(new URL("../package.json", import.meta.url));
const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string };

function runCli(args: readonly string[]): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync("npx", ["tsx", cliPath, ...args], { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test("cli build --help exits 0 and mentions --repo", () => {
  const { status, stdout } = runCli(["build", "--help"]);
  equal(status, 0);
  match(stdout, /--repo/);
});

test("cli install --help exits 0 and mentions --dry-run", () => {
  const { status, stdout } = runCli(["install", "--help"]);
  equal(status, 0);
  match(stdout, /--dry-run/);
});

test("cli install --help mentions --mode", () => {
  const { status, stdout } = runCli(["install", "--help"]);
  equal(status, 0);
  match(stdout, /--mode/);
});

test("cli update defaults to the remote source", () => {
  const { status, stdout } = runCli(["update", "--help"]);
  equal(status, 0);
  match(stdout, /--mode=<mode>.*Default: remote/);
});

test("cli install --mode with an unknown value exits non-zero", () => {
  const { status, stderr } = runCli(["install", "--mode=bogus"]);
  notEqual(status, 0);
  match(stderr, /Unknown install mode "bogus"/);
});

test("cli init --help exits 0 and mentions --marketplace and --vendors", () => {
  const { status, stdout } = runCli(["init", "--help"]);
  equal(status, 0);
  match(stdout, /--marketplace/);
  match(stdout, /--vendors/);
});

test("cli uninstall --help exits 0 and mentions --repo", () => {
  const { status, stdout } = runCli(["uninstall", "--help"]);
  equal(status, 0);
  match(stdout, /--repo/);
});

test("cli with unknown subcommand exits non-zero", () => {
  const { status } = runCli(["nonsense-subcommand"]);
  notEqual(status, 0);
});

test("cli --version prints the package version", () => {
  const { status, stdout } = runCli(["--version"]);
  equal(status, 0);
  ok(
    stdout.includes(pkg.version),
    `expected --version stdout to include ${pkg.version}, got: ${stdout}`,
  );
});

test("cli check --help exits 0 and mentions --repo", () => {
  const { status, stdout } = runCli(["check", "--help"]);
  equal(status, 0);
  match(stdout, /--repo/);
});

test("cli lint --help exits 0 and mentions --repo", () => {
  const { status, stdout } = runCli(["lint", "--help"]);
  equal(status, 0);
  match(stdout, /--repo/);
});

test("cli publish --help exits 0 and mentions --vendors", () => {
  const { status, stdout } = runCli(["publish", "--help"]);
  equal(status, 0);
  match(stdout, /--vendors/);
});

test("cli publish without --vendors publishes every vendor declared in harness.yaml", () => {
  const root = mkdtempSync(join(tmpdir(), "harness-cli-publish-"));
  try {
    const repo = join(root, "source");
    const remote = join(root, "remote.git");
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: "foo",
      GIT_AUTHOR_EMAIL: "foo@example.com",
      GIT_COMMITTER_NAME: "foo",
      GIT_COMMITTER_EMAIL: "foo@example.com",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    };
    const git = (cwd: string, ...args: string[]): string =>
      execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
    git(root, "init", "-q", "--bare", remote);
    git(root, "init", "-q", "-b", "main", repo);
    mkdirSync(join(repo, "plugins/foo"), { recursive: true });
    writeFileSync(
      join(repo, "plugins/foo/plugin.json"),
      JSON.stringify({
        $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
        name: "foo",
        version: "1.0.0",
        description: "Foo.",
      }),
    );
    writeFileSync(
      join(repo, "harness.yaml"),
      "marketplace: foo-market\nowner: { name: foo }\nvendors:\n  claude: { ref: out/claude }\n  codex: { ref: out/codex }\n",
    );
    writeFileSync(join(repo, ".gitignore"), ".harness/\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "init");
    git(repo, "remote", "add", "origin", remote);
    const result = spawnSync("npx", ["tsx", cliPath, "publish", "--repo", repo], {
      encoding: "utf8",
      env,
    });
    equal(result.status, 0, result.stderr);
    equal(
      git(remote, "for-each-ref", "--format=%(refname)"),
      "refs/heads/out/claude\nrefs/heads/out/codex",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
