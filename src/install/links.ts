import { readFile, readlink, rm } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";

import { z } from "zod";

import { formatZodIssues } from "../errors/index.js";
import { errnoCode, pathExists, readdirOrEmpty } from "../fs.js";
import { applyLink } from "../link/applier.js";
import { applyMerge } from "../link/merger.js";
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

export interface PlanConfigsOptions {
  readonly repoRoot: string;
  readonly distRoot: string;
  readonly vendors: readonly Vendor[];
}

export interface ApplyConfigsOptions extends PlanConfigsOptions {
  readonly log: (msg: string) => void;
}

export interface PlannedConfig {
  readonly srcAbs: string;
  readonly destAbs: string;
  readonly vendor: string;
  readonly reason: "link" | "alias" | "merge";
}

export async function planConfigs(options: PlanConfigsOptions): Promise<readonly PlannedConfig[]> {
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
  const plan: PlannedConfig[] = [];
  for (const link of parsed.data.links) {
    const srcAbs = join(options.distRoot, link.src);
    for (const vendorName of link.vendors) {
      const vendor = vendorsByName.get(vendorName);
      if (!vendor) continue;
      const placement = vendor.configPlacement(link.destRel);
      if (placement === null) continue;
      const { strategy, destAbs } = placement;
      plan.push({ srcAbs, destAbs, vendor: vendor.name, reason: strategy });
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

export async function applyConfigs(options: ApplyConfigsOptions): Promise<void> {
  const plan = await planConfigs(options);
  await sweepOrphanLinks(plan, options);
  for (const entry of plan) {
    await applyPlannedConfig(entry, options);
  }
}

async function applyPlannedConfig(
  entry: PlannedConfig,
  options: ApplyConfigsOptions,
): Promise<void> {
  if (entry.reason === "merge") {
    await applyMerge({ ...entry, managedRoot: options.distRoot, log: options.log });
    return;
  }
  await applyLink(entry);
}

async function sweepOrphanLinks(
  plan: readonly PlannedConfig[],
  options: PlanConfigsOptions,
): Promise<void> {
  const managedRoot = options.distRoot + "/";
  const planned = new Set(plan.map((p) => p.destAbs));
  const scanDirs = new Set<string>([
    ...options.vendors.filter((v) => v.name !== "codex").map((v) => v.home),
    ...plan.map((p) => dirname(p.destAbs)),
  ]);

  for (const dir of scanDirs) {
    const entries = await readdirOrEmpty(dir);
    for (const name of entries) {
      const path = join(dir, name);
      if (planned.has(path)) continue;
      if (
        options.vendors.some((v) => v.name === "claude" && path === join(v.home, "settings.json"))
      ) {
        continue;
      }
      const target = await readlinkOrNull(path);
      if (target === null) continue;
      const absTarget = resolve(dir, target);
      if (!absTarget.startsWith(managedRoot)) continue;
      await rm(path);
    }
  }
}

async function readlinkOrNull(path: string): Promise<string | null> {
  try {
    return await readlink(path);
  } catch (e) {
    const code = errnoCode(e);
    if (code === "EINVAL" || code === "ENOENT") return null;
    throw e;
  }
}

export function formatPlannedConfig(entry: PlannedConfig, repoRoot: string): string {
  const src = relative(repoRoot, entry.srcAbs);
  const tag = entry.reason === "link" ? "" : ` (${entry.reason})`;
  return `[${entry.vendor}] ${src} → ${entry.destAbs}${tag}`;
}
