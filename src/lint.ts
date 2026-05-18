import { resolve } from "node:path";

import { main as markdownlintCli2Main } from "markdownlint-cli2";

export interface LintOptions {
  readonly outRoot?: string;
  readonly silent?: boolean;
}

export interface LintResult {
  readonly errorCount: number;
}

const DEFAULT_GLOBS = ["plugins/**/*.md"] as const;

const DEFAULT_CONFIG = {
  default: true,
  MD013: false,
  MD024: { siblings_only: true },
  MD031: { list_items: false },
  MD033: false,
  MD041: false,
} as const;

export async function lint(options: LintOptions = {}): Promise<LintResult> {
  const outRoot = resolve(options.outRoot ?? "./dist");
  const log = options.silent ? (): void => undefined : (line: string): void => console.log(line);
  const exitCode = await markdownlintCli2Main({
    directory: outRoot,
    argv: [...DEFAULT_GLOBS],
    optionsDefault: { config: { ...DEFAULT_CONFIG } },
    logMessage: log,
    logError: log,
  });
  return { errorCount: exitCode };
}
