# Programmatic API

Everything the `harness` CLI does is also available as a typed module API. Use this when scripting a multi-step pipeline, embedding harness-kit into a larger compile system, or wiring a custom [`Vendor`](./vendors.md).

```ts
import {
  compile,
  compilePlugins,
  install,
  uninstall,
  initHarness,
  lint,
  check,
  builtinVendors,
  resolveVendors,
  loadHarnessConfig,
} from "@jean.gnc/harness-kit";
```

All exports are re-exported from the package root; see [`src/index.ts`](../src/index.ts) for the full surface.

## Compile

### `compile(options: CompileOptions): Promise<void>`

Compiles `src/` to `dist/`. Reads `harness.yaml` at `repoRoot` to determine vendors. Emits per-vendor subtrees under `dist/<vendor>/` (plugins, configs, and the vendor marketplace manifest) plus a top-level `dist/configs.json` link manifest.

```ts
await compile({
  srcRoot: "./src",
  outRoot: "./dist",
  repoRoot: ".",
});
```

### `compilePlugins(options: CompilePluginsOptions): Promise<void>`

Lower-level entry. `compile` is `compilePlugins` with vendor resolution wired up plus configs handling — prefer `compile` unless you need to inject vendors or skip `harness.yaml` reads and configs.

## Lint

### `lint(options: LintOptions): Promise<LintResult>`

```ts
const result = await lint({ outRoot: "./dist", silent: false });
if (result.errorCount > 0) process.exit(1);
```

Runs `markdownlint-cli2` against `plugins/**/*.md` with harness-kit's bundled rules. See the README's CLI section for the rule set.

## Install / Uninstall

### `install(options: InstallOptions): Promise<void>`

```ts
import {
  builtinVendors,
  install,
  loadHarnessConfig,
  resolveVendors,
} from "@jean.gnc/harness-kit";

const config = await loadHarnessConfig(".");
const vendors = resolveVendors(config.vendors, builtinVendors());
await install({ distRoot: "./dist", repoRoot: ".", vendors });
```

Applies config links from `dist/configs.json` (replacing existing symlinks, backing up regular files) and calls each vendor's `install` hook.

### `uninstall(options: InstallOptions): Promise<void>`

Same shape as `install`. Calls each vendor's `uninstall` hook.

> **Note:** `installWithRunner` and `uninstallWithRunner` are exported but `@internal` — they exist so tests can inject a recording `CommandRunner`. Don't depend on them from application code.

## Init

### `initHarness(options: InitOptions): Promise<void>`

```ts
await initHarness({
  repoRoot: ".",
  marketplace: "my-harness",
  vendors: ["claude", "codex"],
});
```

Writes `harness.yaml`, scaffolds `src/<vendor>/configs/` for each vendor, `src/plugins/`, and adds `dist/` to `.gitignore`. Fails if `harness.yaml` already exists.

## Vendor interface

See [docs/vendors.md](./vendors.md) for the full `Vendor` interface and a walkthrough of writing one.

Helpers exported here:

- `builtinVendors(): readonly Vendor[]` — returns `[claudeVendor, codexVendor]`.
- `resolveVendors(names, available): readonly Vendor[]` — looks up vendor names against an available list; throws on unknown names.
- `loadHarnessConfig(repoRoot): Promise<HarnessConfig>` — parses `harness.yaml` or `harness.yml`.

## Check

### `check(options: CheckOptions): Promise<CheckResult>`

```ts
const result = await check({ srcRoot: "./src" });
for (const v of result.violations) {
  console.log(`${v.file}:${v.line}:${v.column} ${v.token} — ${v.message}`);
}
```

References resolve against the union of local artifacts and the installed-plugin index. An unresolved reference into a **local** plugin (artifact missing) is a `violation`; an unresolved reference into an **external** plugin is an `unresolved-external` entry in `warnings`. Pass `sources` to override the installed-plugin index (defaults to the vendor homes).

## Installed index

Discover and index plugins already installed under a vendor home. Useful for the `sources` override on `check` and for ad-hoc tooling that needs to enumerate installed skills/agents/commands.

```ts
import { defaultSources, discoverInstalled, indexInstalled } from "@jean.gnc/harness-kit";

const sources = await defaultSources(); // claude + codex homes
const artifacts = await discoverInstalled(sources);
const index = indexInstalled(artifacts);
```

Types: `InstalledIndex`, `InstalledSkill`, `InstalledAgent`, `InstalledCommand`, `InstalledArtifacts`, `PluginSource`.

## Eval

Run routing + solving evals and render the report. `runEval` loads cases from `casesDir`, runs them, and returns a `Result` — `err` carries the per-file load errors when a case file is malformed.

```ts
import { runEval, formatConsole, toJson } from "@jean.gnc/harness-kit";

const result = await runEval({ casesDir: "./evals/cases", cwd: "." });
if (!result.ok) throw new Error(`bad case files: ${result.error.length}`);

const report = result.value;            // { cases, passed, failed }
console.log(formatConsole(report));     // human-readable table
await writeFile("out.json", toJson(report));
```

`EvalOptions` narrows a run: `suite`, `caseId`, `tier`, `runs`, `concurrency`, `model`, `judgeModel`, `solvingTimeoutMs`. Inject a custom `judge` to bypass the default `claude`-CLI judge, or an `onRun` callback for progress. Sessions and the judge spawn the `claude` CLI on its own auth — no API key.

Case files are validated by `CaseFileSchema` (exported alongside `TIERS`); types: `EvalReport`, `CaseReport`, `CaseFile`, `EvalCase`, `Expectation`, `Tier`.

## Skill + plugin authoring

Use these in `SKILL.ts` / `PLUGIN.ts` files for typed metadata:

```ts
import { defineSkill, definePlugin } from "@jean.gnc/harness-kit";

export default defineSkill({
  name: "my-skill",
  description: "What the skill does — single line.",
});
```

Also exported: `parsePlaceholders`, `substitute`, `loadSkill`, `findSkillFile`, `checkCompanionFiles`, plus all related schemas (`SkillSchema`, `PluginSchema`, `CompanionSchema`) and types (`Skill`, `Plugin`, `LoadedSkill`, `Companion`, …).

## Result type

A small `Result<T, E>` helper used internally for fallible operations:

```ts
import { err, ok, type Result } from "@jean.gnc/harness-kit";

function parse(input: string): Result<Parsed, string> {
  if (input === "") return err("empty input");
  return ok({ value: input });
}
```
