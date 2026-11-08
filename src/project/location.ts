import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { defaultRunner, type CommandRunner } from "../install/runner.js";
import { assertRegular, command, digest } from "./io.js";
import { requireReady } from "./state.js";

export interface ProjectLocation {
  readonly project: string;
  readonly stateRoot: string;
  readonly home: string;
}

export async function locateProject(
  options: { readonly project: string; readonly stateRoot: string },
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
  const statePath = resolve(options.stateRoot);
  assertRegular(statePath, "directory");
  const stateRoot = canonicalDestination(statePath);
  if (contains(project, stateRoot)) throw new Error("Codex state must live outside the project");
  return {
    project,
    stateRoot,
    home: join(stateRoot, `${basename(project)}-${digest(project).slice(0, 16)}`),
  };
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
  options: { readonly project: string; readonly stateRoot: string },
  run: CommandRunner = defaultRunner,
): Promise<string> {
  const location = await locateProject(options, run);
  requireReady(location);
  return location.home;
}
