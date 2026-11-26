import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import yaml from "js-yaml";
import { z } from "zod";

import { formatZodIssues } from "../errors/index.js";
import { pathExists } from "../fs.js";
import { kebabName } from "../schema-primitives.js";

const OwnerSchema = z
  .object({
    name: z.string().min(1),
    email: z.string().min(1).optional(),
    url: z.string().min(1).optional(),
  })
  .strict();

const BRANCH_SEGMENT = String.raw`(?![^/]*\.lock(?:/|$))[A-Za-z0-9_](?:[A-Za-z0-9._-]*[A-Za-z0-9_-])?`;
const BRANCH_PATTERN = new RegExp(
  String.raw`^(?!HEAD$)(?!.*\.\.)${BRANCH_SEGMENT}(?:/${BRANCH_SEGMENT})*$`,
);

const VendorSettingsSchema = z
  .object({
    ref: z.string().regex(BRANCH_PATTERN, "must be a git branch name such as harness/claude"),
    catalog: z.record(z.string().min(1), z.unknown()).optional(),
  })
  .strict();

const VendorsSchema = z
  .record(z.string().min(1), VendorSettingsSchema)
  .transform((entries) =>
    Object.entries(entries).map(([name, settings]) => ({
      name,
      ref: settings.ref,
      catalog: settings.catalog ?? {},
    })),
  )
  .superRefine((declarations, ctx) => {
    if (declarations.length === 0) {
      ctx.addIssue({ code: "custom", message: "at least one vendor must be declared" });
    }
    const refs = declarations.map(({ ref }) => ref);
    refs.forEach((ref, index) => {
      const clash = refs.slice(index + 1).find((other) => refsCollide(ref, other));
      if (clash !== undefined) {
        ctx.addIssue({ code: "custom", message: `refs "${ref}" and "${clash}" collide in git` });
      }
    });
  });

function refsCollide(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

const HarnessConfigSchema = z
  .object({
    marketplace: kebabName,
    owner: OwnerSchema,
    vendors: VendorsSchema,
    roots: z.record(z.string().min(1), z.string().min(1)).optional(),
  })
  .strict();

export type Owner = z.infer<typeof OwnerSchema>;

export type VendorDeclaration = z.output<typeof VendorsSchema>[number];

export type HarnessConfig = z.output<typeof HarnessConfigSchema>;

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
    const issues = [...legacyShapeHints(doc), ...formatZodIssues(parsed.error)];
    throw new Error(`harness.yaml at ${path}: ${issues.join("; ")}`);
  }
  return parsed.data;
}

function legacyShapeHints(doc: unknown): readonly string[] {
  if (typeof doc !== "object" || doc === null) return [];
  const hints: string[] = [];
  if ("vendors" in doc && Array.isArray(doc.vendors)) {
    hints.push("vendors is a map since 2.0: `vendors: { claude: { ref: harness/claude } }`");
  }
  if ("extensions" in doc) {
    hints.push("top-level extensions moved to vendors.<vendor>.catalog in 2.0");
  }
  return hints;
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
