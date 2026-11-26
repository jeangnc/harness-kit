import type { Dirent } from "node:fs";
import { readdir, readFile, readlink } from "node:fs/promises";
import { join, posix } from "node:path";

import { errnoCode } from "../fs.js";
import { err, ok, type Result } from "../result.js";

export interface EffectiveTree {
  readonly root: string;
  readonly vendor: string;
  readonly files: ReadonlyMap<string, string>;
}

export type OverlayError =
  | { readonly kind: "misplaced-vendor-dir"; readonly path: string; readonly vendor: string }
  | {
      readonly kind: "redundant-overlay";
      readonly relPath: string;
      readonly overlayPath: string;
      readonly neutralPath: string;
    };

export interface EffectiveTreeOptions {
  readonly root: string;
  readonly vendor: string;
  readonly registeredVendors: readonly string[];
}

export async function effectiveTree(
  options: EffectiveTreeOptions,
): Promise<Result<EffectiveTree, readonly OverlayError[]>> {
  const { root, vendor, registeredVendors } = options;
  const vendors = new Set(registeredVendors);
  const scan = await scanTree(root, vendors);
  const neutral = scan.entries.filter((entry) => entry.layer === null);
  const overlay = scan.entries
    .filter((entry) => entry.layer === vendor)
    .map((entry) => ({ ...entry, relPath: stripLayer(entry.relPath) }));
  const neutralByPath = new Map(neutral.map((entry) => [entry.relPath, entry]));
  const redundancies = await findRedundancies(overlay, neutralByPath);
  const errors = [...scan.misplaced, ...redundancies];
  if (errors.length > 0) return err(errors);
  return ok({ root, vendor, files: mergeLayers(neutral, overlay) });
}

export function resolveIn(tree: EffectiveTree, relPath: string): string | undefined {
  return tree.files.get(relPath);
}

export function formatOverlayError(error: OverlayError): string {
  switch (error.kind) {
    case "misplaced-vendor-dir":
      return `found vendor directory "${error.vendor}" at ${error.path}; vendor overlays are expected only directly under the root`;
    case "redundant-overlay":
      return `overlay ${error.overlayPath} is identical to ${error.neutralPath} for "${error.relPath}"; expected the overlay to differ or be removed`;
  }
}

type EntryKind = "file" | "symlink";

interface Entry {
  readonly relPath: string;
  readonly absPath: string;
  readonly kind: EntryKind;
  readonly layer: string | null;
}

interface Scan {
  readonly entries: readonly Entry[];
  readonly misplaced: readonly OverlayError[];
}

interface Location {
  readonly absPath: string;
  readonly relPath: string;
  readonly layer: string | null;
}

const emptyScan: Scan = { entries: [], misplaced: [] };

async function scanTree(root: string, vendors: ReadonlySet<string>): Promise<Scan> {
  const children = await readdirOrMissing(root);
  const scans = await Promise.all(
    children.map(async (child) => {
      const location = { absPath: join(root, child.name), relPath: child.name, layer: null };
      if (child.isDirectory() && vendors.has(child.name)) {
        return scanDirectory({ ...location, layer: child.name }, vendors);
      }
      return scanEntry(child, location, vendors);
    }),
  );
  return concatScans(scans);
}

async function readdirOrMissing(dir: string): Promise<readonly Dirent[]> {
  try {
    const dirents = await readdir(dir, { withFileTypes: true });
    return dirents.sort((a, b) => comparePaths(a.name, b.name));
  } catch (e) {
    if (errnoCode(e) === "ENOENT") return [];
    throw e;
  }
}

async function scanEntry(
  dirent: Dirent,
  location: Location,
  vendors: ReadonlySet<string>,
): Promise<Scan> {
  if (dirent.isSymbolicLink()) return { ...emptyScan, entries: [{ ...location, kind: "symlink" }] };
  if (!dirent.isDirectory()) return { ...emptyScan, entries: [{ ...location, kind: "file" }] };
  const nested = await scanDirectory(location, vendors);
  if (!vendors.has(dirent.name)) return nested;
  const misplaced: OverlayError = {
    kind: "misplaced-vendor-dir",
    path: location.absPath,
    vendor: dirent.name,
  };
  return { ...nested, misplaced: [misplaced, ...nested.misplaced] };
}

async function scanDirectory(location: Location, vendors: ReadonlySet<string>): Promise<Scan> {
  const children = await readdirOrMissing(location.absPath);
  const scans = await Promise.all(
    children.map(async (child) =>
      scanEntry(
        child,
        {
          absPath: join(location.absPath, child.name),
          relPath: posix.join(location.relPath, child.name),
          layer: location.layer,
        },
        vendors,
      ),
    ),
  );
  return concatScans(scans);
}

function concatScans(scans: readonly Scan[]): Scan {
  return {
    entries: scans.flatMap((scan) => scan.entries),
    misplaced: scans.flatMap((scan) => scan.misplaced),
  };
}

function stripLayer(relPath: string): string {
  return relPath.slice(relPath.indexOf("/") + 1);
}

async function findRedundancies(
  overlay: readonly Entry[],
  neutralByPath: ReadonlyMap<string, Entry>,
): Promise<readonly OverlayError[]> {
  const checks = await Promise.all(
    overlay.map(async (entry): Promise<OverlayError | null> => {
      const shadowed = neutralByPath.get(entry.relPath);
      if (shadowed === undefined) return null;
      if (!(await isIdentical(entry, shadowed))) return null;
      return {
        kind: "redundant-overlay",
        relPath: entry.relPath,
        overlayPath: entry.absPath,
        neutralPath: shadowed.absPath,
      };
    }),
  );
  return checks.filter((check) => check !== null);
}

async function isIdentical(a: Entry, b: Entry): Promise<boolean> {
  if (a.kind !== b.kind) return false;
  const [left, right] = await Promise.all([contentOf(a), contentOf(b)]);
  return left.equals(right);
}

async function contentOf(entry: Entry): Promise<Buffer> {
  switch (entry.kind) {
    case "file":
      return readFile(entry.absPath);
    case "symlink":
      return Buffer.from(await readlink(entry.absPath));
  }
}

function comparePaths(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function mergeLayers(
  neutral: readonly Entry[],
  overlay: readonly Entry[],
): ReadonlyMap<string, string> {
  const merged = new Map([...neutral, ...overlay].map((entry) => [entry.relPath, entry.absPath]));
  return new Map([...merged].sort(([a], [b]) => comparePaths(a, b)));
}
