#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { defineCommand, runMain } from "citty";
import { z } from "zod";

import { build } from "./build.js";
import { CHECK_MODES, check, type CheckMode, type ExtViolation } from "./check/index.js";
import { initHarness } from "./init/index.js";
import { install, uninstall } from "./install/index.js";
import { lint } from "./lint.js";
import { builtinVendors } from "./vendor/builtins.js";
import { resolveVendors, resolveVendorsForRepo } from "./vendor/registry.js";

const PackageJsonSchema = z.object({ version: z.string().min(1) });

const pkgPath = fileURLToPath(new URL("../package.json", import.meta.url));
const pkg = PackageJsonSchema.parse(JSON.parse(readFileSync(pkgPath, "utf8")));

function isCheckMode(value: string): value is CheckMode {
  return (CHECK_MODES as readonly string[]).includes(value);
}

function parseCheckMode(value: string): CheckMode {
  if (isCheckMode(value)) return value;
  throw new Error(`Unknown check mode "${value}". Valid: ${CHECK_MODES.join(", ")}`);
}

const buildCmd = defineCommand({
  meta: { name: "build", description: "Compile harness sources to dist/" },
  args: {
    src: { type: "string", default: "./src", description: "source root" },
    out: { type: "string", default: "./dist", description: "output root" },
    repo: { type: "string", default: ".", description: "repo root (where harness.yaml lives)" },
    silent: { type: "boolean", default: false, description: "suppress success log" },
  },
  run: async ({ args }) => {
    await build({
      srcRoot: args.src,
      outRoot: args.out,
      repoRoot: args.repo,
      silent: args.silent,
    });
  },
});

const installArgs = {
  dist: { type: "string", default: "./dist", description: "dist root" },
  repo: { type: "string", default: ".", description: "repo root (where harness.yaml lives)" },
  silent: { type: "boolean", default: false, description: "suppress success log" },
  "dry-run": { type: "boolean", default: false, description: "print plan without applying" },
} as const;

const installCmd = defineCommand({
  meta: { name: "install", description: "Link configs + register plugins per declared vendor" },
  args: installArgs,
  run: async ({ args }) => {
    const vendors = await resolveVendorsForRepo(args.repo);
    await install({
      distRoot: args.dist,
      repoRoot: args.repo,
      vendors,
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
      distRoot: args.dist,
      repoRoot: args.repo,
      vendors,
      silent: args.silent,
      dryRun: args["dry-run"],
    });
  },
});

const initCmd = defineCommand({
  meta: {
    name: "init",
    description: "Scaffold a harness repo (harness.yaml, src/configs, src/plugins)",
  },
  args: {
    repo: { type: "string", default: ".", description: "repo root to scaffold into" },
    marketplace: { type: "string", required: true, description: "marketplace name" },
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
    const vendors = args.vendors
      .split(",")
      .map((v) => v.trim())
      .filter((v) => v.length > 0);
    if (vendors.length === 0) throw new Error("--vendors must list at least one vendor");
    resolveVendors(vendors, builtinVendors());
    await initHarness({
      repoRoot: args.repo,
      marketplace: args.marketplace,
      vendors,
      silent: args.silent,
    });
  },
});

const checkCmd = defineCommand({
  meta: {
    name: "check",
    description: "Validate plugin references — local, installed (ext:), or both",
  },
  args: {
    src: { type: "string", default: "./src", description: "source root" },
    mode: {
      type: "string",
      default: "installed",
      description: "validation scope: local | installed | all",
    },
    silent: { type: "boolean", default: false, description: "suppress non-error output" },
  },
  run: async ({ args }) => {
    const mode = parseCheckMode(args.mode);
    const result = await check({ srcRoot: args.src, mode });
    if (!args.silent) {
      const breakdown = result.indexedSources.map((s) => `${s.source}=${s.skillCount}`).join(", ");
      const total = result.indexedSources.reduce((acc, s) => acc + s.skillCount, 0);
      console.log(
        `indexed ${total} skills across ${result.indexedSources.length} sources (${breakdown})`,
      );
      console.log(`checked ${result.checkedFiles} source files`);
      if (result.violations.length > 0) console.log("");
    }
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

function formatViolation(v: ExtViolation): string {
  return `${v.file}:${v.line}:${v.column}  \`${v.token}\` — ${v.message}`;
}

const lintCmd = defineCommand({
  meta: {
    name: "lint",
    description: "Lint compiled markdown under dist/ with harness-kit's default rules",
  },
  args: {
    out: { type: "string", default: "./dist", description: "output root" },
    silent: { type: "boolean", default: false, description: "suppress non-error output" },
  },
  run: async ({ args }) => {
    const result = await lint({ outRoot: args.out, silent: args.silent });
    if (result.errorCount > 0) process.exit(1);
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
    build: buildCmd,
    check: checkCmd,
    init: initCmd,
    install: installCmd,
    lint: lintCmd,
    uninstall: uninstallCmd,
  },
});

await runMain(main);
