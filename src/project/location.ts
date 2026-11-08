import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import { defaultRunner, type CommandRunner } from "../install/runner.js";
import { assertRegular, command } from "./io.js";
import { readMetadata, requireReady } from "./state.js";

export interface ProjectLocationOptions {
  readonly project: string;
  readonly stateRoot?: string;
  readonly homeName?: string;
}

export interface ProjectLocation {
  readonly project: string;
  readonly stateRoot: string;
  readonly home: string;
}

export async function locateProject(
  options: ProjectLocationOptions,
  run: CommandRunner = defaultRunner,
): Promise<ProjectLocation> {
  const projectPath = realpathSync(options.project);
  const project = realpathSync(
    (
      await command({
        run,
        program: "git",
        args: ["rev-parse", "--show-toplevel"],
        cwd: projectPath,
      })
    ).trim(),
  );
  const homeName = projectHomeName(options.homeName ?? basename(project));
  const statePath = resolve(options.stateRoot ?? join(homedir(), ".codex", "projects"));
  assertRegular(statePath, "directory");
  const stateRoot = canonicalDestination(statePath);
  const home = join(stateRoot, homeName);
  if (contains(project, home)) throw new Error("Codex state must live outside the project");
  const location = {
    project,
    stateRoot,
    home,
  };
  readMetadata(location);
  return location;
}

function projectHomeName(name: string): string {
  if (
    name.length === 0 ||
    name !== name.trim() ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\\") ||
    name.includes("\0") ||
    /[\r\n]/.test(name)
  ) {
    throw new Error(
      "Project home name must be a single directory name without surrounding whitespace or line breaks, other than . or ..",
    );
  }
  return name;
}

function canonicalDestination(path: string): string {
  const missing: string[] = [];
  let ancestor = path;
  while (!existsSync(ancestor)) {
    missing.unshift(basename(ancestor));
    ancestor = dirname(ancestor);
  }
  return join(realpathSync(ancestor), ...missing);
}

export function contains(parent: string, child: string): boolean {
  return child === parent || child.startsWith(`${parent}/`);
}

export async function selectProject(
  options: ProjectLocationOptions,
  run: CommandRunner = defaultRunner,
): Promise<string> {
  const location = await locateProject(options, run);
  requireReady(location);
  return location.home;
}
