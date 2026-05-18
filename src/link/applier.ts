import { lstat, mkdir, rename, rm, symlink } from "node:fs/promises";
import { dirname } from "node:path";

export interface ApplyLinkOptions {
  readonly srcAbs: string;
  readonly destAbs: string;
}

export async function applyLink(options: ApplyLinkOptions): Promise<void> {
  const { srcAbs, destAbs } = options;
  await mkdir(dirname(destAbs), { recursive: true });
  const existing = await lstatOrNull(destAbs);
  if (existing) {
    if (existing.isSymbolicLink()) {
      await rm(destAbs);
    } else {
      await rename(destAbs, await pickBackupPath(destAbs));
    }
  }
  await symlink(srcAbs, destAbs);
}

async function pickBackupPath(destAbs: string): Promise<string> {
  const base = `${destAbs}.backup`;
  if ((await lstatOrNull(base)) === null) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}.${i}`;
    if ((await lstatOrNull(candidate)) === null) return candidate;
  }
  throw new Error(`could not find a free backup path for ${destAbs}`);
}

async function lstatOrNull(path: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(path);
  } catch (e) {
    if (e instanceof Error && "code" in e && e.code === "ENOENT") return null;
    throw e;
  }
}
