import { readdir, stat } from "node:fs/promises";

export async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

export async function readdirOrEmpty(dir: string): Promise<readonly string[]> {
  try {
    return await readdir(dir);
  } catch (e) {
    if (errnoCode(e) === "ENOENT") return [];
    throw e;
  }
}

export function errnoCode(e: unknown): string | null {
  if (e instanceof Error && "code" in e && typeof e.code === "string") return e.code;
  return null;
}
