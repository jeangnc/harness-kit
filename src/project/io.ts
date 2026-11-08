import { createHash } from "node:crypto";
import { lstatSync, readFileSync, renameSync, writeFileSync } from "node:fs";

import type { CommandRunner } from "../install/runner.js";

export async function command(options: {
  readonly run: CommandRunner;
  readonly program: string;
  readonly args: readonly string[];
  readonly cwd: string;
}): Promise<string> {
  const { run, program, args, cwd } = options;
  try {
    return (await run(program, args, { cwd, env: {} })) ?? "";
  } catch {
    throw new Error(`${program} ${args.slice(0, 2).join(" ")} failed; output withheld`);
  }
}

export function assertRegular(path: string, type: "file" | "directory"): void {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  if (stat.isSymbolicLink() || (type === "file" ? !stat.isFile() : !stat.isDirectory())) {
    throw new Error(`Expected a regular ${type} at ${path}`);
  }
}

export function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`Unable to parse JSON at ${path}; contents withheld`);
  }
}

export function privateWrite(path: string, contents: string): void {
  assertRegular(path, "file");
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, contents, { mode: 0o600, flag: "wx" });
  renameSync(temporary, path);
}

export function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
