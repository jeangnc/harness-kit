import { test } from "node:test";
import { equal, match, notEqual, ok } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
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
