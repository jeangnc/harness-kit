import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rename,
  rm,
  readFile,
  readlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import type { Vendor } from "../vendor/schema.js";
import { errnoCode } from "../fs.js";

interface RuntimeOptions {
  readonly distRoot: string;
  readonly vendors: readonly Vendor[];
  readonly dryRun?: boolean;
}

interface Migration {
  readonly path: string;
  readonly backup: string;
}

export async function migrateRuntime(options: RuntimeOptions): Promise<readonly Migration[]> {
  await recoverRuntime(options);
  const paths = await managedRuntimeLinks(options);
  const migrated: Migration[] = [];
  for (const path of paths) {
    if (options.dryRun) {
      migrated.push({ path, backup: "(created on migration)" });
      continue;
    }
    const staging = await mkdtemp(join(dirname(path), ".harness-runtime-"));
    const backup = join(staging, "backup");
    const incoming = join(staging, "incoming");
    await cp(path, backup, { recursive: true, dereference: true, preserveTimestamps: true });
    await cp(backup, incoming, { recursive: true, preserveTimestamps: true });
    if ((await lstat(incoming)).isDirectory()) {
      const displaced = join(staging, "original-link");
      await writeFile(join(staging, "target"), basename(path));
      await rename(path, displaced);
      try {
        await rename(incoming, path);
      } catch (cause) {
        await rename(displaced, path);
        throw cause;
      }
    } else {
      await rename(incoming, path);
    }
    await rm(join(staging, "target"), { force: true });
    migrated.push({ path, backup });
  }
  return migrated;
}

async function recoverRuntime(options: RuntimeOptions): Promise<void> {
  for (const vendor of options.vendors) {
    for (const directory of ancestors(vendor.home)) await recoverInterrupted(directory, options);
    if (vendor.name !== "codex") continue;
    for (const name of ["profiles", "hooks", "configs"]) {
      await recoverNested(join(vendor.home, name), options);
    }
  }
}

async function recoverNested(directory: string, options: RuntimeOptions): Promise<void> {
  if (!(await lstatOrNull(directory))?.isDirectory()) return;
  await recoverInterrupted(directory, options);
  for (const name of await readdir(directory)) {
    if (name.startsWith(".harness-runtime-")) continue;
    await recoverNested(join(directory, name), options);
  }
}

function ancestors(path: string): readonly string[] {
  const parent = dirname(path);
  return parent === path ? [path] : [...ancestors(parent), path];
}

async function recoverInterrupted(directory: string, options: RuntimeOptions): Promise<void> {
  const info = await lstatOrNull(directory);
  if (!info?.isDirectory()) return;
  for (const entry of await readdir(directory)) {
    if (!entry.startsWith(".harness-runtime-")) continue;
    const staging = join(directory, entry);
    const marker = join(staging, "target");
    if (!(await lstatOrNull(marker))) continue;
    const name = await readFile(marker, "utf8");
    if (name !== basename(name) || name === "." || name === "..") {
      throw new Error(`invalid migration target at ${marker}`);
    }
    const target = join(directory, name);
    if (
      !options.vendors.some(
        (vendor) =>
          vendor.home === target ||
          vendor.home.startsWith(target + "/") ||
          target.startsWith(vendor.home + "/"),
      )
    ) {
      continue;
    }
    const placed = await lstatOrNull(target);
    if (placed) {
      if (
        !placed.isSymbolicLink() &&
        !(await lstatOrNull(join(staging, "incoming"))) &&
        !options.dryRun
      ) {
        await rm(marker);
      }
      continue;
    }
    if (options.dryRun) {
      throw new Error(
        `interrupted migration at ${staging}; rerun migrate-runtime without --dry-run`,
      );
    }
    const incoming = join(staging, "incoming");
    if (!(await lstatOrNull(incoming))) {
      throw new Error(`interrupted migration has no preserved incoming copy at ${staging}`);
    }
    await rename(incoming, target);
    await rm(marker);
  }
}

export async function assertRuntimeDetached(options: RuntimeOptions): Promise<void> {
  await recoverRuntime({ ...options, dryRun: true });
  const links = await managedRuntimeLinks(options);
  if (links.length > 0) {
    throw new Error(
      `runtime files resolve into generated output; run harness migrate-runtime before compiling:\n${links.join("\n")}`,
    );
  }
}

async function managedRuntimeLinks(options: RuntimeOptions): Promise<readonly string[]> {
  const root = await canonical(options.distRoot);
  const links: string[] = [];
  for (const vendor of options.vendors) {
    const ancestor = await managedAncestor(vendor.home, root);
    if (ancestor) {
      if (!links.includes(ancestor)) links.push(ancestor);
      continue;
    }
    if (vendor.name === "codex") {
      await findLinks(vendor.home, root, links);
    } else if (vendor.name === "claude") {
      await inspectLink(join(vendor.home, "settings.json"), root, links);
    }
  }
  return links;
}

async function managedAncestor(path: string, root: string): Promise<string | null> {
  const parent = dirname(path);
  if (parent !== path) {
    const ancestor = await managedAncestor(parent, root);
    if (ancestor) return ancestor;
  }
  if (!(await lstatOrNull(path))?.isSymbolicLink()) return null;
  const target = await canonical(path);
  const rel = relative(root, target);
  return target === root || (rel !== ".." && !rel.startsWith("../") && !rel.startsWith("/"))
    ? path
    : null;
}

async function findLinks(path: string, root: string, links: string[], depth = 0): Promise<void> {
  const info = await lstatOrNull(path);
  if (!info) return;
  if (info.isSymbolicLink()) {
    await inspectLink(path, root, links);
    return;
  }
  if (!info.isDirectory()) return;
  for (const name of await readdir(path)) {
    if (name === "plugins" || name.startsWith(".harness-runtime-")) continue;
    const child = join(path, name);
    const childInfo = await lstatOrNull(child);
    if (
      depth === 0 &&
      childInfo?.isDirectory() &&
      !["profiles", "hooks", "configs"].includes(name)
    ) {
      continue;
    }
    await findLinks(child, root, links, depth + 1);
  }
}

async function inspectLink(path: string, root: string, links: string[]): Promise<void> {
  const target = await canonical(path);
  const rel = relative(root, target);
  if (target === root || (rel !== ".." && !rel.startsWith("../") && !rel.startsWith("/"))) {
    links.push(path);
  }
}

async function canonical(path: string, visited = new Set<string>()): Promise<string> {
  path = resolve(path);
  if (visited.has(path)) throw new Error(`cannot resolve cyclic runtime link at ${path}`);
  visited.add(path);
  try {
    return await realpath(path);
  } catch (cause) {
    if (errnoCode(cause) !== "ENOENT") throw cause;
    if ((await lstatOrNull(path))?.isSymbolicLink()) {
      return canonical(resolve(dirname(path), await readlink(path)), visited);
    }
    const parent = dirname(path);
    return parent === path ? path : join(await canonical(parent, visited), basename(path));
  }
}

async function lstatOrNull(path: string) {
  try {
    return await lstat(path);
  } catch (cause) {
    if (errnoCode(cause) === "ENOENT") return null;
    throw cause;
  }
}

export async function installDefaults(options: {
  readonly distRoot: string;
  readonly target?: string;
  readonly dryRun?: boolean;
}): Promise<string | undefined> {
  const target = options.target ?? "/etc/codex/config.toml";
  if (options.dryRun) return;
  await mkdir(dirname(target), { recursive: true });
  const staging = await mkdtemp(join(dirname(target), ".harness-defaults-"));
  try {
    const incoming = join(staging, "config.toml");
    await cp(join(options.distRoot, "codex/configs/config.toml"), incoming);
    const exists = await lstatOrNull(target);
    const backup = exists ? join(staging, "backup") : undefined;
    if (backup) await cp(target, backup, { dereference: true, preserveTimestamps: true });
    await rename(incoming, target);
    if (!backup) await rm(staging, { recursive: true, force: true });
    return backup;
  } catch (cause) {
    throw new Error(`cannot publish defaults to ${target}; staging preserved at ${staging}`, {
      cause,
    });
  }
}
