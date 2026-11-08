import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { defaultRunner, type CommandRunner } from "../install/runner.js";
import { assertRegular, command, digest, privateWrite } from "./io.js";
import type { ProjectPlan } from "./plan.js";
import { requireReady } from "./state.js";

export async function enrollProject(
  plan: ProjectPlan,
  run: CommandRunner = defaultRunner,
): Promise<void> {
  requireReady(plan);
  const path = join(plan.project, ".envrc");
  assertRegular(path, "file");
  const previous = existsSync(path) ? readFileSync(path, "utf8") : "";
  const selection = `export CODEX_HOME=${shellPath(plan.home)}`;
  if (previous.split("\n").includes(selection)) return;
  if (/use_codex_project|CODEX_HOME/.test(previous)) {
    throw new Error(`Existing Codex environment selection conflicts at ${path}`);
  }
  const backup = join(plan.home, "envrc.before-setup");
  if (!existsSync(backup)) privateWrite(backup, previous);
  const tracked = (
    await command({ run, program: "git", args: ["ls-files", "--", ".envrc"], cwd: plan.project })
  ).trim();
  if (!tracked) {
    const exclude = resolve(
      plan.project,
      (
        await command({
          run,
          program: "git",
          args: ["rev-parse", "--git-path", "info/exclude"],
          cwd: plan.project,
        })
      ).trim(),
    );
    assertRegular(exclude, "file");
    const exclusions = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
    if (!exclusions.split("\n").includes("/.envrc")) {
      mkdirSync(dirname(exclude), { recursive: true });
      privateWrite(exclude, append(exclusions, "/.envrc\n"));
    }
  }
  const next = append(previous, selection + "\n");
  privateWrite(path, next);
  privateWrite(join(plan.home, "envrc.installed.sha256"), digest(next) + "\n");
}

function shellPath(value: string): string {
  const userHome = homedir();
  if (value === userHome) return "~";
  if (value.startsWith(`${userHome}/`)) {
    const suffix = value.slice(userHome.length + 1);
    return `~/${/^[a-zA-Z0-9_./-]+$/.test(suffix) ? suffix : quote(suffix)}`;
  }
  return quote(value);
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function append(previous: string, next: string): string {
  return previous + (previous.endsWith("\n") || !previous ? "" : "\n") + next;
}

export async function verifyEnvironment(plan: ProjectPlan, run: CommandRunner): Promise<void> {
  for (const scope of plan.scopes) {
    const output = await command({
      run,
      program: "direnv",
      args: [
        "exec",
        scope.cwd,
        process.execPath,
        "-e",
        "process.stdout.write(process.env.CODEX_HOME || '')",
      ],
      cwd: scope.cwd,
    });
    if (output.trim() !== plan.home) {
      throw new Error(`direnv selected a different home at ${scope.cwd}`);
    }
  }
}
