#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { defineCommand, runMain } from "citty";
import { z } from "zod";

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { commaSeparated, parsePositiveInt, parseTier } from "./args/index.js";
import { migrateRuntime, installDefaults } from "./install/runtime.js";
import { build } from "./build.js";
import { formatRepositoryError, resolveRepository } from "./repository/index.js";
import { formatPublishError, formatPublishOutcome, publishVendors } from "./publish/index.js";
import { layoutAt, legacyBuildDir } from "./layout/index.js";
import { check, type ReferenceViolation, type Warning } from "./check/index.js";
import { formatConsole, runEval, toJson } from "./eval/index.js";
import { TIERS } from "./eval/schema.js";
import { initHarness } from "./init/index.js";
import { formatUpdateError, install, uninstall, update } from "./install/index.js";
import { parseInstallMode } from "./install/mode.js";
import { lint } from "./lint.js";
import { projectCmd } from "./project/cli.js";
import { builtinVendors } from "./vendor/builtins.js";
import { resolveVendors, resolveVendorsForRepo } from "./vendor/registry.js";

const PackageJsonSchema = z.object({ version: z.string().min(1) });

const pkgPath = fileURLToPath(new URL("../package.json", import.meta.url));
const pkg = PackageJsonSchema.parse(JSON.parse(readFileSync(pkgPath, "utf8")));

const buildCmd = defineCommand({
  meta: { name: "build", description: "Build per-vendor marketplaces into .harness/" },
  args: {
    repo: { type: "string", default: ".", description: "repo root (where harness.yaml lives)" },
    silent: { type: "boolean", default: false, description: "suppress success log" },
  },
  run: async ({ args }) => {
    await build({
      repoRoot: args.repo,
      silent: args.silent,
    });
  },
});

const installArgs = {
  repo: { type: "string", default: ".", description: "repo root (where harness.yaml lives)" },
  silent: { type: "boolean", default: false, description: "suppress success log" },
  "dry-run": { type: "boolean", default: false, description: "print plan without applying" },
} as const;

const migrateRuntimeCmd = defineCommand({
  meta: {
    name: "migrate-runtime",
    description: "Detach legacy runtime links while preserving contents",
  },
  args: { ...installArgs, vendor: { type: "string", required: true } },
  run: async ({ args }) => {
    const vendors = resolveVendors([args.vendor], builtinVendors());
    const roots = [layoutAt(args.repo).buildDir, legacyBuildDir(args.repo)];
    const changes = await Promise.all(
      roots.map(async (distRoot) => migrateRuntime({ distRoot, vendors, dryRun: args["dry-run"] })),
    );
    for (const change of changes.flat()) {
      console.log(`${change.path} → regular copy; backup: ${change.backup}`);
    }
  },
});

const installDefaultsCmd = defineCommand({
  meta: {
    name: "install-defaults",
    description: "Publish Codex machine defaults separately from runtime settings",
  },
  args: { ...installArgs, vendor: { type: "string", required: true } },
  run: async ({ args }) => {
    if (args.vendor !== "codex") throw new Error("install-defaults supports only codex");
    const backup = await installDefaults({
      distRoot: layoutAt(args.repo).buildDir,
      dryRun: args["dry-run"],
    });
    if (backup) console.log(`Previous defaults preserved at ${backup}`);
    console.log(`${args["dry-run"] ? "Would publish" : "Published"} /etc/codex/config.toml`);
  },
});

const installCmd = defineCommand({
  meta: { name: "install", description: "Link configs + register plugins per declared vendor" },
  args: {
    ...installArgs,
    mode: { type: "string", default: "local", description: "install source: local | remote" },
  },
  run: async ({ args }) => {
    const mode = parseInstallMode(args.mode);
    const vendors = await resolveVendorsForRepo(args.repo);
    await install({
      repoRoot: args.repo,
      vendors,
      mode,
      silent: args.silent,
      dryRun: args["dry-run"],
    });
  },
});

const uninstallCmd = defineCommand({
  meta: { name: "uninstall", description: "Remove installed plugins per declared vendor" },
  args: installArgs,
  run: async ({ args }) => {
    const vendors = await resolveVendorsForRepo(args.repo);
    await uninstall({
      repoRoot: args.repo,
      vendors,
      silent: args.silent,
      dryRun: args["dry-run"],
    });
  },
});

const updateCmd = defineCommand({
  meta: {
    name: "update",
    description: "Refresh plugins for an already-installed harness (skips config-link bootstrap)",
  },
  args: {
    ...installArgs,
    mode: { type: "string", default: "remote", description: "install source: local | remote" },
    prune: {
      type: "boolean",
      default: false,
      description: "remove installed plugins that are no longer shipped",
    },
  },
  run: async ({ args }) => {
    const mode = parseInstallMode(args.mode);
    const vendors = await resolveVendorsForRepo(args.repo);
    const result = await update({
      repoRoot: args.repo,
      vendors,
      mode,
      silent: args.silent,
      dryRun: args["dry-run"],
      prune: args.prune,
    });
    if (!result.ok) {
      console.error(formatUpdateError(result.error));
      process.exit(1);
    }
  },
});

const publishCmd = defineCommand({
  meta: {
    name: "publish",
    description: "Build, then publish each vendor build to the branch named after the vendor",
  },
  args: {
    repo: { type: "string", default: ".", description: "repo root (where harness.yaml lives)" },
    vendors: {
      type: "string",
      default: "",
      description:
        "comma-separated vendors to publish; empty publishes every vendor in harness.yaml",
    },
    remote: { type: "string", default: "origin", description: "git remote to push to" },
  },
  run: async ({ args }) => {
    const declared = await resolveVendorsForRepo(args.repo);
    const requested = commaSeparated(args.vendors);
    const vendors = requested.length === 0 ? declared : resolveVendors(requested, declared);
    const result = await publishVendors({
      layout: layoutAt(args.repo),
      vendors: vendors.map((vendor) => vendor.name),
      remote: args.remote,
      build: async () => build({ repoRoot: args.repo, silent: true }),
    });
    if (!result.ok) {
      console.error(formatPublishError(result.error));
      process.exit(1);
    }
    for (const outcome of result.value) console.log(formatPublishOutcome(outcome));
  },
});

const initCmd = defineCommand({
  meta: {
    name: "init",
    description: "Scaffold a harness repo (harness.yaml, plugins/, configs/, release workflow)",
  },
  args: {
    repo: { type: "string", default: ".", description: "repo root to scaffold into" },
    marketplace: { type: "string", required: true, description: "marketplace name" },
    owner: {
      type: "string",
      default: "",
      description: "marketplace owner name; empty uses the GitHub owner of the origin remote",
    },
    vendors: {
      type: "string",
      required: true,
      description: `comma-separated vendors (known: ${builtinVendors()
        .map((v) => v.name)
        .join(", ")})`,
    },
    silent: { type: "boolean", default: false, description: "suppress success log" },
  },
  run: async ({ args }) => {
    const vendors = commaSeparated(args.vendors);
    if (vendors.length === 0) throw new Error("--vendors must list at least one vendor");
    resolveVendors(vendors, builtinVendors());
    await initHarness({
      repoRoot: args.repo,
      marketplace: args.marketplace,
      owner: { name: args.owner === "" ? await repositoryOwner(args.repo) : args.owner },
      vendors,
      silent: args.silent,
    });
  },
});

async function repositoryOwner(repoRoot: string): Promise<string> {
  const repository = await resolveRepository({ cwd: repoRoot, env: process.env });
  if (!repository.ok) {
    throw new Error(`${formatRepositoryError(repository.error)}; or pass --owner`);
  }
  return repository.value.owner;
}

const checkCmd = defineCommand({
  meta: {
    name: "check",
    description: "Validate plugin references",
  },
  args: {
    repo: { type: "string", default: ".", description: "repo root (where harness.yaml lives)" },
    docs: {
      type: "string",
      description:
        "comma-separated files or directories outside plugins/ to check for stale references",
    },
    silent: { type: "boolean", default: false, description: "suppress non-error output" },
  },
  run: async ({ args }) => {
    const result = await check({ repoRoot: args.repo, docRoots: commaSeparated(args.docs) });
    if (!args.silent) {
      const breakdown = result.indexedSources.map((s) => `${s.source}=${s.skillCount}`).join(", ");
      const total = result.indexedSources.reduce((acc, s) => acc + s.skillCount, 0);
      console.log(
        `indexed ${total} skills across ${result.indexedSources.length} sources (${breakdown})`,
      );
      console.log(`checked ${result.checkedFiles} source files`);
      if (result.warnings.length > 0) console.log("");
    }
    for (const w of result.warnings) {
      console.log(formatWarning(w));
    }
    if (!args.silent && result.warnings.length > 0) {
      console.log("");
      console.log(`${result.warnings.length} warnings`);
    }
    if (!args.silent && result.violations.length > 0) console.log("");
    for (const v of result.violations) {
      console.log(formatViolation(v));
    }
    if (result.violations.length > 0) {
      if (!args.silent) {
        console.log("");
        console.log(`${result.violations.length} violations`);
      }
      process.exit(1);
    }
  },
});

function formatViolation(v: ReferenceViolation): string {
  return `${v.file}:${v.line}:${v.column}  \`${v.token}\` — ${v.message}`;
}

function formatWarning(w: Warning): string {
  return `${w.file}:${w.line}:${w.column}  warning: ${w.message}`;
}

const lintCmd = defineCommand({
  meta: {
    name: "lint",
    description: "Lint built markdown under .harness/ with harness-kit's default rules",
  },
  args: {
    repo: { type: "string", default: ".", description: "repo root (where harness.yaml lives)" },
    silent: { type: "boolean", default: false, description: "suppress non-error output" },
  },
  run: async ({ args }) => {
    const result = await lint({ repoRoot: args.repo, silent: args.silent });
    if (result.errorCount > 0) process.exit(1);
  },
});

const evalCmd = defineCommand({
  meta: {
    name: "eval",
    description: "Run routing (did the right skill fire?) and solving (graded behavior) evals",
  },
  args: {
    cases: {
      type: "string",
      default: "./evals/cases",
      description: "directory of eval case files",
    },
    cwd: { type: "string", default: ".", description: "working directory for agent sessions" },
    dist: {
      type: "string",
      default: "./.harness",
      description:
        "local built plugins to overlay over the installed cache (local wins); empty to disable",
    },
    suite: { type: "string", description: "only run cases from this suite" },
    case: { type: "string", description: "only run the case with this id" },
    tier: { type: "string", description: `only run this tier: ${TIERS.join(" | ")}` },
    runs: { type: "string", description: "runs per case (overrides per-case default)" },
    concurrency: {
      type: "string",
      default: "1",
      description: "max concurrent sessions (parallel sessions interfere with routing; default 1)",
    },
    model: {
      type: "string",
      description: "model for agent sessions (default: user's configured model)",
    },
    "judge-model": {
      type: "string",
      description: "model for the solving-tier LLM judge (default: opus)",
    },
    "solving-timeout": {
      type: "string",
      description: "per-case timeout in seconds for solving sessions (default: 300)",
    },
    json: { type: "string", description: "write machine-readable results to this path" },
  },
  run: async ({ args }) => {
    const result = await runEval({
      casesDir: args.cases,
      cwd: args.cwd,
      concurrency: parsePositiveInt(args.concurrency, "concurrency"),
      ...(args.dist !== "" && { distRoot: args.dist }),
      ...(args.suite !== undefined && { suite: args.suite }),
      ...(args.case !== undefined && { caseId: args.case }),
      ...(args.tier !== undefined && { tier: parseTier(args.tier) }),
      ...(args.runs !== undefined && { runs: parsePositiveInt(args.runs, "runs") }),
      ...(args.model !== undefined && { model: args.model }),
      ...(args["judge-model"] !== undefined && { judgeModel: args["judge-model"] }),
      ...(args["solving-timeout"] !== undefined && {
        solvingTimeoutMs: parsePositiveInt(args["solving-timeout"], "solving-timeout") * 1000,
      }),
    });

    if (!result.ok) {
      for (const e of result.error) console.error(`${e.file}: ${e.message}`);
      process.exit(1);
    }

    console.log(formatConsole(result.value));
    if (args.json) {
      await mkdir(dirname(args.json), { recursive: true });
      await writeFile(args.json, toJson(result.value) + "\n");
    }
    if (result.value.failed > 0) process.exit(1);
  },
});

const main = defineCommand({
  meta: {
    name: "harness",
    version: pkg.version,
    description:
      "Build your own multi-agent harness: author plugins once, ship to every declared vendor.",
  },
  subCommands: {
    check: checkCmd,
    build: buildCmd,
    publish: publishCmd,
    eval: evalCmd,
    init: initCmd,
    install: installCmd,
    "migrate-runtime": migrateRuntimeCmd,
    "install-defaults": installDefaultsCmd,
    lint: lintCmd,
    project: projectCmd,
    uninstall: uninstallCmd,
    update: updateCmd,
  },
});

await runMain(main);
