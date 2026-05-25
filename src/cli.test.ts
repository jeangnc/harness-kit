import { test } from "node:test";
import { strict as assert } from "node:assert";
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

test("cli compile --help exits 0 and mentions --src", () => {
  const { status, stdout } = runCli(["compile", "--help"]);
  assert.equal(status, 0);
  assert.match(stdout, /--src/);
});

test("cli install --help exits 0 and mentions --dry-run", () => {
  const { status, stdout } = runCli(["install", "--help"]);
  assert.equal(status, 0);
  assert.match(stdout, /--dry-run/);
});

test("cli install --help mentions --mode", () => {
  const { status, stdout } = runCli(["install", "--help"]);
  assert.equal(status, 0);
  assert.match(stdout, /--mode/);
});

test("cli install --mode with an unknown value exits non-zero", () => {
  const { status, stderr } = runCli(["install", "--mode=bogus"]);
  assert.notEqual(status, 0);
  assert.match(stderr, /Unknown install mode "bogus"/);
});

test("cli init --help exits 0 and mentions --marketplace and --vendors", () => {
  const { status, stdout } = runCli(["init", "--help"]);
  assert.equal(status, 0);
  assert.match(stdout, /--marketplace/);
  assert.match(stdout, /--vendors/);
});

test("cli uninstall --help exits 0 and mentions --dist", () => {
  const { status, stdout } = runCli(["uninstall", "--help"]);
  assert.equal(status, 0);
  assert.match(stdout, /--dist/);
});

test("cli with unknown subcommand exits non-zero", () => {
  const { status } = runCli(["nonsense-subcommand"]);
  assert.notEqual(status, 0);
});

test("cli --version prints the package version", () => {
  const { status, stdout } = runCli(["--version"]);
  assert.equal(status, 0);
  assert.ok(
    stdout.includes(pkg.version),
    `expected --version stdout to include ${pkg.version}, got: ${stdout}`,
  );
});

test("cli check --help exits 0 and mentions --src", () => {
  const { status, stdout } = runCli(["check", "--help"]);
  assert.equal(status, 0);
  assert.match(stdout, /--src/);
});

test("cli lint --help exits 0 and mentions --out", () => {
  const { status, stdout } = runCli(["lint", "--help"]);
  assert.equal(status, 0);
  assert.match(stdout, /--out/);
});
