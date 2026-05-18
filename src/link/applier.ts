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
      await rename(destAbs, `${destAbs}.backup`);
    }
  }
  await symlink(srcAbs, destAbs);
}

async function lstatOrNull(path: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(path);
  } catch (e) {
    if (e instanceof Error && "code" in e && e.code === "ENOENT") return null;
    throw e;
  }
}
