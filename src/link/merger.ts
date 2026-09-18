import { lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { z } from "zod";

import { errnoCode } from "../fs.js";
import {
  formatKeyPath,
  mergeOwnedToml,
  type KeyPath,
  type TomlMerge,
  type TomlMergeInput,
} from "./tomlMerge.js";

export interface ApplyMergeOptions {
  readonly srcAbs: string;
  readonly destAbs: string;
  readonly managedRoot: string;
  readonly log: (msg: string) => void;
}

const LedgerSchema = z.object({ owned: z.array(z.array(z.string())) });

export async function applyMerge(options: ApplyMergeOptions): Promise<void> {
  const { srcAbs, destAbs } = options;
  const ledgerPath = ledgerPathFor(destAbs);
  const merge = mergeOrExplain(destAbs, {
    current: (await readFileOrNull(destAbs)) ?? "",
    owned: await readFile(srcAbs, "utf8"),
    previouslyOwned: await readLedger(ledgerPath),
  });
  for (const path of merge.overwritten) {
    options.log(`[config] ${destAbs}: ${formatKeyPath(path)} reset to the value in ${srcAbs}`);
  }
  const adopted = await isManagedLink(destAbs, options.managedRoot);
  if (adopted) await rm(destAbs);
  await mkdir(dirname(destAbs), { recursive: true });
  await writeFile(destAbs, merge.text);
  if (adopted) return;
  await mkdir(dirname(ledgerPath), { recursive: true });
  await writeFile(ledgerPath, JSON.stringify({ owned: merge.owned }, null, 2) + "\n");
}

function ledgerPathFor(destAbs: string): string {
  return join(dirname(destAbs), ".harness-kit", `${basename(destAbs)}.owned.json`);
}

function mergeOrExplain(destAbs: string, input: TomlMergeInput): TomlMerge {
  try {
    return mergeOwnedToml(input);
  } catch (e) {
    throw new Error(
      `cannot merge configs into ${destAbs}: ${e instanceof Error ? e.message : String(e)}`,
      {
        cause: e,
      },
    );
  }
}

async function readFileOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (e) {
    if (errnoCode(e) === "ENOENT") return null;
    throw e;
  }
}

async function readLedger(ledgerPath: string): Promise<readonly KeyPath[]> {
  const raw = await readFileOrNull(ledgerPath);
  if (raw === null) return [];
  return LedgerSchema.parse(JSON.parse(raw)).owned;
}

async function isManagedLink(destAbs: string, managedRoot: string): Promise<boolean> {
  const stat = await lstat(destAbs).catch(() => null);
  if (!stat?.isSymbolicLink()) return false;
  const target = await realpath(destAbs).catch(() => null);
  return target === null || target.startsWith(`${await realpath(managedRoot)}/`);
}
