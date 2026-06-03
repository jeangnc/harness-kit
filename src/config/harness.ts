import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import yaml from "js-yaml";
import { z } from "zod";

import { formatZodIssues } from "../errors/index.js";
import { pathExists } from "../fs.js";

const HarnessConfigSchema = z.object({
  marketplace: z.string().min(1, "marketplace is required"),
  vendors: z.array(z.string().min(1)).min(1, "at least one vendor must be declared"),
  roots: z.record(z.string().min(1), z.string().min(1)).optional(),
});

export type HarnessConfig = z.infer<typeof HarnessConfigSchema>;

const CANDIDATES = ["harness.yaml", "harness.yml"] as const;

export async function loadHarnessConfig(repoRoot: string): Promise<HarnessConfig> {
  const found: string[] = [];
  for (const name of CANDIDATES) {
    if (await pathExists(join(repoRoot, name))) found.push(name);
  }
  if (found.length > 1) {
    throw new Error(`both harness.yaml and harness.yml exist in ${repoRoot} — pick one`);
  }
  const name = found[0];
  if (name === undefined) {
    throw new Error(`harness.yaml not found in ${repoRoot}`);
  }
  const path = join(repoRoot, name);
  const raw = await readFile(path, "utf8");
  let doc: unknown;
  try {
    doc = yaml.load(raw);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    throw new Error(`harness.yaml at ${path}: ${reason}`);
  }
  const parsed = HarnessConfigSchema.safeParse(doc);
  if (!parsed.success) {
    throw new Error(`harness.yaml at ${path}: ${formatZodIssues(parsed.error).join("; ")}`);
  }
  return parsed.data;
}

export async function resolveRootsForRepo(
  repoRoot: string,
): Promise<Readonly<Record<string, string>>> {
  const config = await loadHarnessConfig(repoRoot);
  return resolveRoots(repoRoot, config.roots);
}

export function resolveRoots(
  repoRoot: string,
  declared: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> {
  if (declared === undefined) return {};
  return Object.fromEntries(
    Object.entries(declared).map(([name, path]) => [name, resolve(repoRoot, path)]),
  );
}
