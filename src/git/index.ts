import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface GitInvocation {
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
}

export interface GitExit {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export async function tryGit(args: readonly string[], invocation: GitInvocation): Promise<GitExit> {
  try {
    const { stdout, stderr } = await execFileAsync("git", [...args], {
      cwd: invocation.cwd,
      env: { ...process.env, ...invocation.env },
      maxBuffer: 64 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (e) {
    if (!isExitFailure(e)) throw e;
    return { code: e.code, stdout: e.stdout, stderr: e.stderr };
  }
}

export async function git(args: readonly string[], invocation: GitInvocation): Promise<string> {
  const exit = await tryGit(args, invocation);
  if (exit.code !== 0) {
    throw new Error(
      `git ${args.join(" ")} in ${invocation.cwd} exited ${exit.code}, expected 0: ${exit.stderr.trim()}`,
    );
  }
  return exit.stdout.trimEnd();
}

function isExitFailure(e: unknown): e is Error & GitExit {
  return (
    e instanceof Error &&
    "code" in e &&
    typeof e.code === "number" &&
    "stdout" in e &&
    typeof e.stdout === "string" &&
    "stderr" in e &&
    typeof e.stderr === "string"
  );
}
