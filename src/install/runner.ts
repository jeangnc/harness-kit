import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type CommandRunner = (
  cmd: string,
  args: readonly string[],
  options?: { readonly env: Readonly<Record<string, string>>; readonly cwd: string },
) => Promise<void | string>;

export const defaultRunner: CommandRunner = async (cmd, args, options) => {
  const { stdout } = await execFileAsync(cmd, [...args], {
    env: { ...process.env, ...options?.env },
    ...(options ? { cwd: options.cwd } : {}),
  });
  return stdout;
};

export async function runIgnoreFailure(
  run: CommandRunner,
  cmd: string,
  args: readonly string[],
): Promise<void> {
  try {
    await run(cmd, args);
  } catch {
    /* ignore */
  }
}
