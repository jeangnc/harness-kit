import { main as markdownlintCli2Main } from "markdownlint-cli2";

import { layoutAt } from "./layout/index.js";
import { resolveVendorsForRepo } from "./vendor/registry.js";
import type { Vendor } from "./vendor/schema.js";

export interface LintOptions {
  readonly repoRoot?: string;
  readonly vendors?: readonly Vendor[];
  readonly silent?: boolean;
}

export interface LintResult {
  readonly errorCount: number;
}

const DEFAULT_CONFIG = {
  default: true,
  MD013: false,
  MD024: { siblings_only: true },
  MD031: { list_items: false },
  MD033: false,
  MD040: false,
  MD041: false,
} as const;

export async function lint(options: LintOptions = {}): Promise<LintResult> {
  const layout = layoutAt(options.repoRoot ?? ".");
  const vendors = options.vendors ?? (await resolveVendorsForRepo(layout.repoRoot));
  const globs = vendorGlobs(vendors);
  const log = options.silent ? (): void => undefined : (line: string): void => console.log(line);
  const exitCode = await markdownlintCli2Main({
    directory: layout.buildDir,
    argv: globs,
    optionsDefault: { config: { ...DEFAULT_CONFIG } },
    logMessage: log,
    logError: log,
  });
  return { errorCount: exitCode };
}

function vendorGlobs(vendors: readonly Vendor[]): string[] {
  return vendors.map((v) => `${v.name}/**/*.md`);
}
