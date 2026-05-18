import { readFile, readdir, readlink, rm } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";

import { z } from "zod";

import { formatZodIssues } from "../errors/index.js";
import { pathExists } from "../fs.js";
import { applyLink } from "../link/applier.js";
import type { Vendor } from "../vendor/schema.js";

const ConfigsManifestSchema = z.object({
  links: z.array(
    z.object({
      src: z.string().min(1),
      vendors: z.array(z.string().min(1)),
      destRel: z.string().min(1),
      kind: z.enum(["file", "dir"]),
    }),
  ),
});

export interface ApplyConfigLinksOptions {
  readonly repoRoot: string;
  readonly distRoot: string;
  readonly vendors: readonly Vendor[];
}

export interface PlannedLink {
  readonly srcAbs: string;
  readonly destAbs: string;
  readonly vendor: string;
  readonly reason: "link" | "alias";
}

export async function planConfigLinks(
  options: ApplyConfigLinksOptions,
): Promise<readonly PlannedLink[]> {
  const manifestPath = join(options.distRoot, "configs.json");
  if (!(await pathExists(manifestPath))) return [];
  const raw = await readFile(manifestPath, "utf8");
  const parsed = ConfigsManifestSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new Error(
      `invalid configs manifest at ${manifestPath}: ${formatZodIssues(parsed.error).join("; ")}`,
    );
  }
  const vendorsByName = new Map(options.vendors.map((v) => [v.name, v]));
  const plan: PlannedLink[] = [];
  for (const link of parsed.data.links) {
    const srcAbs = join(options.repoRoot, "src", link.src);
    for (const vendorName of link.vendors) {
      const vendor = vendorsByName.get(vendorName);
      if (!vendor) continue;
      const destAbs = join(vendor.home, link.destRel);
      plan.push({ srcAbs, destAbs, vendor: vendor.name, reason: "link" });
      const aliasDests =
        vendor.aliases?.({
          srcAbs,
          destAbs,
          destRel: link.destRel,
          basename: basename(link.destRel),
        }) ?? [];
      for (const aliasDest of aliasDests) {
        plan.push({ srcAbs, destAbs: aliasDest, vendor: vendor.name, reason: "alias" });
      }
    }
  }
  return plan;
}

export async function applyConfigLinks(options: ApplyConfigLinksOptions): Promise<void> {
  const plan = await planConfigLinks(options);
  await sweepOrphanLinks(plan, options);
  for (const entry of plan) {
    await applyLink({ srcAbs: entry.srcAbs, destAbs: entry.destAbs });
  }
}

async function sweepOrphanLinks(
  plan: readonly PlannedLink[],
  options: ApplyConfigLinksOptions,
): Promise<void> {
  const managedSrcRoot = join(options.repoRoot, "src") + "/";
  const planned = new Set(plan.map((p) => p.destAbs));
  const scanDirs = new Set<string>();
  for (const vendor of options.vendors) scanDirs.add(vendor.home);
  for (const entry of plan) scanDirs.add(dirname(entry.destAbs));

  for (const dir of scanDirs) {
    const entries = await readdirOrEmpty(dir);
    for (const name of entries) {
      const path = join(dir, name);
      if (planned.has(path)) continue;
      const target = await readlinkOrNull(path);
      if (target === null) continue;
      const absTarget = resolve(dir, target);
      if (!absTarget.startsWith(managedSrcRoot)) continue;
      await rm(path);
    }
  }
}

async function readdirOrEmpty(dir: string): Promise<readonly string[]> {
  try {
    return await readdir(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
}

async function readlinkOrNull(path: string): Promise<string | null> {
  try {
    return await readlink(path);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EINVAL" || code === "ENOENT") return null;
    throw e;
  }
}

export function formatPlannedLink(entry: PlannedLink, repoRoot: string): string {
  const src = relative(repoRoot, entry.srcAbs);
  const tag = entry.reason === "alias" ? " (alias)" : "";
  return `[${entry.vendor}] ${src} → ${entry.destAbs}${tag}`;
}
